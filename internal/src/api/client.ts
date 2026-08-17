import { request, type Dispatcher } from 'undici';
import type { Logger } from 'pino';
import { HttpError, NoEnergyError, SessionExpiredError } from './errors.js';
import type { Account } from '../vault/schema.js';
import { makeProxyAgent } from '../wallet/proxy-agent.js';
import { humanizeFromRange, sleep as timingSleep } from '../timing.js';
import { loadTimingConfig } from '../timing-config.js';

// Load timing config once at module load — picks up ~/.gigabot/timing.json or env overrides.
const tcfg = loadTimingConfig();
import {
  type ActionRequest,
  type ActionResponse,
  type EnergyState,
  type GameItemCatalogEntry,
  type GameItemMetadata,
  type GearInstance,
  type GearItemCatalogEntry,
  type GearSetResponse,
  type GearRepairResponse,
  type GearSalvageResponse,
  type ItemBalanceEntity,
  type OffchainStaticResponse,
  makeAction,
  type DungeonStateResponse,
  type DungeonTodayResponse,
  type RecipeStartRequest,
  type RecipeStartResponse,
  type RacingLobbySyncRequest,
  type RacingUseItemRequest,
} from './types.js';

const BASE = 'https://gigaverse.io';
const REQUEST_TIMEOUT_MS = 20_000;
const TRANSIENT_TRANSPORT_ERROR_CODES = new Set([
  'EADDRNOTAVAIL',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_INFO',
  'UND_ERR_REQ_RETRY',
]);

/**
 * Pool of realistic Chrome user-agent strings rotated per account so multiple
 * accounts on the same IP don't share an identical fingerprint. Each entry is
 * paired with matching `sec-ch-ua-*` client hints — the divergence between UA
 * version and client-hint version is a known bot tell.
 */
interface UAEntry {
  ua: string;
  chUa: string;
  chPlatform: string;
}

const UA_POOL: UAEntry[] = [
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    chUa: '"Chromium";v="148", "Not_A Brand";v="24", "Google Chrome";v="148"',
    chPlatform: '"macOS"',
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    chUa: '"Chromium";v="147", "Not_A Brand";v="24", "Google Chrome";v="147"',
    chPlatform: '"macOS"',
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    chUa: '"Chromium";v="146", "Not_A Brand";v="24", "Google Chrome";v="146"',
    chPlatform: '"Windows"',
  },
  {
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    chUa: '"Chromium";v="145", "Not_A Brand";v="24", "Google Chrome";v="145"',
    chPlatform: '"Linux"',
  },
];

/** Pick a stable UA index from the account name so reruns of the same account use the same fingerprint. */
function pickUA(seed: string): UAEntry {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return UA_POOL[Math.abs(h) % UA_POOL.length]!;
}

/** Build the per-account header bundle (anti-sybil: stable fingerprint per account). */
export function buildHeaders(seed: string): Record<string, string> {
  const ua = pickUA(seed);
  return {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    origin: BASE,
    referer: `${BASE}/play`,
    'sec-ch-ua': ua.chUa,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': ua.chPlatform,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': ua.ua,
  };
}

export interface GigaClientOptions {
  /** Override dispatcher (useful for tests with MockAgent). If absent, builds ProxyAgent from account.proxy. */
  dispatcher?: Dispatcher;
}

export class GigaClient {
  private dispatcher: Dispatcher;
  private headers: Record<string, string>;

  /** Bearer JWT set by setJwt() after successful login. */
  private jwt: string | undefined;

  /**
   * Replay-protection token echoed from the last successful action response.
   * Reset to '' at construction; updated automatically after each action call.
   */
  private lastActionToken: string = '';

  constructor(
    account: Account,
    private log: Logger,
    opts: GigaClientOptions = {},
  ) {
    this.dispatcher = opts.dispatcher ?? makeProxyAgent(account.proxy);
    this.headers = buildHeaders(account.name);
  }

  /**
   * Store the Gigaverse JWT.  Called by loginToGigaverse() in src/api/auth.ts
   * after successful SIWE login.
   */
  setJwt(jwt: string): void {
    this.jwt = jwt;
  }

  /** Return the last actionToken received from the server. */
  getActionToken(): string {
    return this.lastActionToken;
  }

  /**
   * Explicitly set the replay-protection token.
   *
   * Use this when the correct token is known from an out-of-band source
   * (e.g. a stale run detected via getDungeonState) so the next action
   * call echoes the right token without first completing a normal action.
   */
  setLastActionToken(token: string): void {
    this.lastActionToken = token;
  }

  async get<T>(path: string, opts: { authed?: boolean } = {}): Promise<T> {
    return this.send<T>('GET', path, undefined, opts);
  }

  async post<T>(
    path: string,
    body: unknown,
    opts: { authed?: boolean; attempts?: number } = {},
  ): Promise<T> {
    return this.send<T>('POST', path, body, opts);
  }

  async action(req: ActionRequest): Promise<ActionResponse> {
    await this.humanDelay();
    // Local retry with MUTABLE req — send()'s internal withRetries captures
    // JSON-stringified body once and reuses it. To rewrite actionToken between
    // attempts we must drive retries from here and pass `attempts: 1` down.
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const response = await this.post<ActionResponse>('/api/game/dungeon/action', req, {
          authed: true,
          attempts: 1,
        });
        this.lastActionToken = response.actionToken ?? '';
        await this.postActionJitter();
        return response;
      } catch (e) {
        const isLast = attempt === MAX_ATTEMPTS - 1;
        const retryableHttp = e instanceof HttpError && (e.status === 429 || e.status >= 500);
        if (!isLast && (retryableHttp || isTransientTransportError(e))) {
          if (e instanceof HttpError && e.status >= 500) {
            const body = e.body as { error?: string; message?: string } | undefined;
            const text = `${body?.error ?? ''} ${body?.message ?? ''}`;
            const match = text.match(/!=\s*(\d+)/);
            if (match) {
              const correct = match[1]!;
              this.log.warn(
                { action: req.action, from: req.actionToken, to: correct },
                'auto-corrected actionToken from server hint',
              );
              req.actionToken = correct;
              this.lastActionToken = correct;
              continue;
            }
          }

          const base = 300 + Math.floor(Math.random() * 400);
          const delay = Math.floor(base * 2 ** attempt * (0.5 + Math.random()));
          this.log.warn(
            { action: req.action, attempt: attempt + 1, delay, err: e },
            'retrying dungeon action',
          );
          await sleep(delay);
          continue;
        }
        throw e;
      }
    }
    throw new Error('action: max attempts exhausted');
  }

  async startRun(dungeonId: 1 | 3): Promise<ActionResponse> {
    // start_run always uses an empty actionToken — there is no prior action.
    return this.action(makeAction('start_run', { dungeonId, actionToken: '' }));
  }

  async move(m: 'rock' | 'paper' | 'scissor'): Promise<ActionResponse> {
    return this.action(makeAction(m, { actionToken: this.lastActionToken }));
  }

  async pickLoot(i: 1 | 2 | 3): Promise<ActionResponse> {
    const name = i === 1 ? 'loot_one' : i === 2 ? 'loot_two' : 'loot_three';
    return this.action(makeAction(name, { actionToken: this.lastActionToken }));
  }

  /**
   * Flee from the current encounter (used when PvP opponent is detected).
   * Resets lastActionToken to '' after completion so the next start_run
   * begins with a clean state.
   */
  async flee(): Promise<ActionResponse> {
    const response = await this.action(makeAction('flee', { actionToken: this.lastActionToken }));
    // Run is over after flee — reset token so next start_run starts clean.
    this.lastActionToken = '';
    return response;
  }

  /**
   * Fetch current energy for a player address.
   *
   * Endpoint: GET /api/offchain/player/energy/<addr>
   * Returns the first entity's parsedData as EnergyState.
   *
   * @throws Error if entities array is empty (unexpected server response).
   */
  async getEnergy(address: string): Promise<EnergyState> {
    const r = await this.get<{ entities: Array<{ parsedData: EnergyState }> }>(
      `/api/offchain/player/energy/${address}`,
      { authed: true },
    );
    const e = r.entities[0]?.parsedData;
    if (!e) throw new Error('energy: empty entities response');
    return e;
  }

  /**
   * Fetch gear instances for a player address.
   *
   * Endpoint: GET /api/gear/instances/<addr>
   */
  async getGearInstances(address: string): Promise<GearInstance[]> {
    const r = await this.get<{ entities?: GearInstance[] }>(`/api/gear/instances/${address}`, {
      authed: true,
    });
    return Array.isArray(r.entities) ? r.entities : [];
  }

  /**
   * Fetch gear item definitions. Used only for human-readable reward names.
   *
   * Endpoint: GET /api/gear/items
   */
  async getGearItemsCatalog(): Promise<GearItemCatalogEntry[]> {
    const r = await this.get<{ entities?: GearItemCatalogEntry[] }>('/api/gear/items');
    return Array.isArray(r.entities) ? r.entities : [];
  }

  /**
   * Fetch ordinary game item definitions. Used only for human-readable reward names.
   *
   * Endpoint: GET /api/indexer/gameitems
   */
  async getGameItemsCatalog(): Promise<GameItemCatalogEntry[]> {
    const r = await this.get<{ entities?: GameItemCatalogEntry[] }>('/api/indexer/gameitems');
    return Array.isArray(r.entities) ? r.entities : [];
  }

  /** Fetch public ERC-1155 metadata, including the item's image and icon. */
  async getGameItemMetadata(gameItemId: number): Promise<GameItemMetadata> {
    return await this.get<GameItemMetadata>(`/api/metadata/gameItem/${gameItemId}`);
  }

  /**
   * Fetch authenticated game item balances.
   *
   * Endpoint: GET /api/items/balances
   */
  async getItemBalances(): Promise<ItemBalanceEntity[]> {
    const r = await this.get<{ entities?: ItemBalanceEntity[] }>('/api/items/balances', {
      authed: true,
    });
    return Array.isArray(r.entities) ? r.entities : [];
  }

  /** Fetch live offchain recipes used by workbench automation. */
  async getOffchainStatic(): Promise<OffchainStaticResponse> {
    return await this.get<OffchainStaticResponse>('/api/offchain/static', { authed: true });
  }

  /** Fetch the current racing lobby and, optionally, one selected race. */
  async syncRacingLobby(body: RacingLobbySyncRequest): Promise<unknown> {
    return await this.post<unknown>('/api/racing/lobby/sync', body, { authed: true });
  }

  /**
   * Use one spectator consumable in a live race.
   *
   * This mutation is deliberately never retried automatically. A transport
   * timeout can happen after the server consumed the item, so replaying it
   * would risk spending a second item.
   */
  async useRacingItem(raceId: number, body: RacingUseItemRequest): Promise<unknown> {
    return await this.post<unknown>(`/api/racing/race/${raceId}/use-item`, body, {
      authed: true,
      attempts: 1,
    });
  }

  /** Advance/read the live spectator simulation exactly as the Racing UI does. */
  async tickRacingRace(raceId: number): Promise<unknown> {
    return await this.post<unknown>(`/api/racing/race/${raceId}/tick`, undefined, {
      authed: true,
    });
  }

  /**
   * Repair a gear instance once. Gigaverse returns the updated gear entity.
   *
   * Endpoint: POST /api/gear/repair
   */
  async repairGear(gearInstanceId: string): Promise<GearRepairResponse> {
    return await this.post<GearRepairResponse>(
      '/api/gear/repair',
      { gearInstanceId },
      { authed: true },
    );
  }

  /**
   * Salvage a gear instance that is no longer useful.
   *
   * Endpoint: POST /api/gear/salvage
   */
  async salvageGear(gearInstanceId: string): Promise<GearSalvageResponse> {
    return await this.post<GearSalvageResponse>(
      '/api/gear/salvage',
      { gearInstanceId },
      { authed: true },
    );
  }

  /** Equip one gear instance into the same slot tuple used by the game UI. */
  async setGear(gearInstanceId: string, slotType: number, slotIndex = 0): Promise<GearSetResponse> {
    return await this.post<GearSetResponse>(
      '/api/gear/set',
      { gearInstanceId, slotType, slotIndex },
      { authed: true },
    );
  }

  /**
   * Start an offchain recipe node such as vase breaking or chest claiming.
   *
   * Endpoint: POST /api/offchain/recipes/start
   */
  async startRecipe(req: RecipeStartRequest): Promise<RecipeStartResponse> {
    return await this.post<RecipeStartResponse>('/api/offchain/recipes/start', req, {
      authed: true,
    });
  }

  /**
   * Check whether the player currently has an active dungeon run.
   *
   * Endpoint: GET /api/offchain/player/activeDungeon/<addr>
   * If a run is in progress, the next `start_run` will fail with
   * "Error starting dungeon" — caller should `flee()` first.
   *
   * Returns `true` if there's an active run, `false` otherwise.
   */
  async hasActiveDungeon(address: string): Promise<boolean> {
    try {
      const r = await this.get<{ entities?: unknown[]; run?: unknown }>(
        `/api/offchain/player/activeDungeon/${address}`,
        { authed: true },
      );
      if (Array.isArray(r.entities) && r.entities.length > 0) return true;
      if (r.run !== null && r.run !== undefined) return true;
      return false;
    } catch {
      // If the endpoint shape is different than expected, assume no active run
      // and let start_run be the source of truth.
      return false;
    }
  }

  /**
   * Fetch the current dungeon run state for the authenticated user.
   *
   * Endpoint: GET /api/game/dungeon/state
   * Used in pre-flight to surface an active or stuck run before start_run is called.
   *
   * Returns the raw server response; never throws on unexpected shapes.
   */
  async getDungeonState(): Promise<DungeonStateResponse> {
    try {
      return await this.get<DungeonStateResponse>('/api/game/dungeon/state', { authed: true });
    } catch {
      // Not a hard failure — diagnostics are best-effort
      return {};
    }
  }

  /**
   * Fetch today's available dungeons.
   *
   * Endpoint: GET /api/game/dungeon/today
   * Used in pre-flight to confirm the configured dungeonId is a valid option.
   *
   * Returns the raw server response; never throws on unexpected shapes.
   */
  async getDungeonToday(): Promise<DungeonTodayResponse> {
    try {
      return await this.get<DungeonTodayResponse>('/api/game/dungeon/today', { authed: true });
    } catch {
      // Not a hard failure — diagnostics are best-effort
      return {};
    }
  }

  /**
   * GET /api/offchain/skills — static skill catalog (4 skills, 8 stats each,
   * cost tables per stat). Cache the result; it doesn't change between runs.
   */
  async getSkillsCatalog(): Promise<unknown> {
    return await this.get<unknown>('/api/offchain/skills', { authed: true });
  }

  /**
   * GET /api/offchain/skills/progress/{noobId} — per-character stat levels
   * across every skill they've touched. noobId is the NOOB_TOKEN_CID
   * (numeric id of the noob NFT).
   */
  async getSkillsProgress(noobId: number): Promise<unknown> {
    return await this.get<unknown>(`/api/offchain/skills/progress/${noobId}`, { authed: true });
  }

  /**
   * POST /api/game/skill/levelup — spend 1 step on a stat.
   *
   * IMPORTANT: the response body holds the PRE-mutation state. Increment your
   * local copy of `LEVEL_CID_array[statId]` after a 200; do NOT trust the
   * response body to reflect the new level.
   */
  async levelUpSkill(body: { skillId: number; statId: number; noobId: number }): Promise<unknown> {
    return await this.post<unknown>('/api/game/skill/levelup', body, { authed: true });
  }

  async getFloors(): Promise<Map<number, bigint>> {
    const r = await this.get<{
      entities: Array<{ GAME_ITEM_ID_CID: number; ETH_MINT_PRICE_CID: string | number }>;
    }>('/api/marketplace/item/floor/all');
    const m = new Map<number, bigint>();
    for (const e of r.entities ?? []) {
      try {
        m.set(e.GAME_ITEM_ID_CID, BigInt(e.ETH_MINT_PRICE_CID));
      } catch {
        // skip malformed entries
      }
    }
    return m;
  }

  private async humanDelay(): Promise<void> {
    await timingSleep(humanizeFromRange(tcfg.action));
  }

  /** Tiny post-action jitter so consecutive actions don't have inhuman regularity. */
  private async postActionJitter(): Promise<void> {
    await timingSleep(humanizeFromRange(tcfg.postAction));
  }

  /** Longer pause before picking loot (humans actually read the boon text). */
  async lootThinking(): Promise<void> {
    await timingSleep(humanizeFromRange(tcfg.lootThinking));
  }

  private async send<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    opts: { authed?: boolean; attempts?: number } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...this.headers };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.authed) {
      // Gigaverse authenticates via Bearer JWT on every API call (not cookies).
      if (!this.jwt) throw new SessionExpiredError();
      headers['authorization'] = 'Bearer ' + this.jwt;
    }

    const url = `${BASE}${path}`;

    return this.withRetries(async () => {
      this.log.debug({ method, path }, 'request');
      const res = await request(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        dispatcher: this.dispatcher,
        headersTimeout: REQUEST_TIMEOUT_MS,
        bodyTimeout: REQUEST_TIMEOUT_MS,
      });
      const text = await res.body.text();
      const parsed: unknown = text ? safeJsonParse(text) : null;

      if (res.statusCode === 401 || res.statusCode === 403) {
        throw new SessionExpiredError();
      }
      // Treat 429 (rate-limited) as transient: respect Retry-After if present.
      if (res.statusCode === 429) {
        const ra = res.headers['retry-after'];
        const waitSec =
          typeof ra === 'string' && /^\d+$/.test(ra)
            ? Number(ra)
            : Array.isArray(ra) && ra[0] && /^\d+$/.test(ra[0])
              ? Number(ra[0])
              : 0;
        if (waitSec > 0) {
          this.log.warn({ waitSec, path }, '429 rate-limited — honoring Retry-After');
          await sleep(waitSec * 1000);
        }
        throw new HttpError(429, parsed, 'rate-limited');
      }
      if (res.statusCode >= 500) {
        // throw so withRetries can retry
        throw new HttpError(res.statusCode, parsed);
      }
      if (res.statusCode >= 400) {
        const msg = extractError(parsed);
        if (/no_energy|energy/i.test(msg)) throw new NoEnergyError();
        throw new HttpError(res.statusCode, parsed, msg);
      }
      return parsed as T;
    }, opts.attempts);
  }

  private async withRetries<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        // Non-retryable errors: 4xx (except 5xx HttpError), explicit session expired, no-energy.
        // 429 IS retryable — Retry-After sleep already applied above, fall through.
        if (e instanceof SessionExpiredError || e instanceof NoEnergyError) throw e;
        if (e instanceof HttpError && e.status < 500 && e.status !== 429) throw e;

        // Defense-in-depth: when the server tells us the expected actionToken in
        // its 500 error body ("Invalid action token X != 1234"), update our local
        // copy so the next retry attempt echoes the correct token automatically.
        if (e instanceof HttpError && e.status === 500) {
          const body = e.body as { error?: string; message?: string } | undefined;
          const hint = body?.error ?? body?.message ?? '';
          const match = /!=\s*(\d+)/.exec(hint);
          if (match) {
            this.lastActionToken = match[1]!;
            this.log.warn(
              { correctedToken: match[1] },
              'auto-corrected actionToken from server hint',
            );
          }
        }

        if (i < attempts - 1) {
          // Exponential backoff with full multiplicative jitter (±50%) so
          // parallel accounts don't thunder-herd-retry in lockstep.
          const base = 300 + Math.floor(Math.random() * 400); // 300-700ms
          const delay = Math.floor(base * 2 ** i * (0.5 + Math.random()));
          this.log.warn({ attempt: i + 1, delay, err: e }, 'retrying');
          await sleep(delay);
        }
      }
    }
    throw lastErr;
  }
}

function extractError(parsed: unknown): string {
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.error === 'string') return obj.error;
  }
  return '';
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isTransientTransportError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (typeof current !== 'object') return false;
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    const code = typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
    if (TRANSIENT_TRANSPORT_ERROR_CODES.has(code)) return true;

    const message = typeof candidate.message === 'string' ? candidate.message : '';
    if (
      /\b(?:EADDRNOTAVAIL|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b/i.test(
        message,
      ) ||
      /HTTP\/2: "(?:stream timeout|GOAWAY|stream error|frameError|stream closed|stream half-closed)/i.test(
        message,
      ) ||
      /socket hang up/i.test(message)
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
