import { createHash, randomUUID } from 'node:crypto';
import { request, type Dispatcher } from 'undici';
import { z } from 'zod';
import type { GigaverseLoginSigner } from '../api/auth.js';
import type { HubPack } from '../hub/pack.js';

type CambriaConfig = HubPack['modules']['cambria'];
type HttpMethod = 'GET' | 'POST' | 'PUT';

const CambriaUserSchema = z
  .object({
    wallet_address: z.string(),
    player_name: z.string().nullable().optional(),
  })
  .passthrough();

const CambriaLootScoreSchema = z
  .object({
    datasetVersion: z.string().min(1),
    eligible: z.boolean(),
    scores: z.object({
      total: z.number(),
      degen: z.number(),
      chad: z.number(),
    }),
    chests: z.object({
      common: z.number().int().nonnegative(),
      epic: z.number().int().nonnegative(),
      legendary: z.number().int().nonnegative(),
    }),
    qualifications: z.array(z.unknown()).default([]),
    evaluatedWalletCounts: z.object({
      evm: z.number().int().nonnegative(),
      svm: z.number().int().nonnegative(),
    }),
    claim: z.unknown().nullable(),
    claimsEnabled: z.boolean(),
  })
  .passthrough();

const CambriaPointsSchema = z
  .object({
    points: z.number(),
    rolling24hPoints: z.number(),
    rank: z.number(),
    multiplier: z.number(),
    updatedAt: z.number().optional(),
  })
  .passthrough();

const CambriaQuestSchema = z
  .object({
    id: z.string(),
    completed: z.boolean(),
    claimed: z.boolean(),
  })
  .passthrough();

const CambriaQuestsSchema = z.object({ quests: z.array(CambriaQuestSchema) }).passthrough();

const PrivyAuthSchema = z
  .object({
    user: z.object({ id: z.string().min(1) }).passthrough(),
    token: z.string().min(1),
    refresh_token: z.string().optional(),
    identity_token: z.string().optional(),
    privy_access_token: z.unknown().optional(),
  })
  .passthrough();

const CambriaProofOfWorkSchema = z.object({
  problem: z.string().min(1),
  difficulty: z.number().int().positive().max(10),
  salt: z.string().min(1),
  challengeId: z.string().min(1),
});

export type CambriaLootScore = z.infer<typeof CambriaLootScoreSchema>;
export type CambriaPoints = z.infer<typeof CambriaPointsSchema>;
export type CambriaQuest = z.infer<typeof CambriaQuestSchema>;
export type CambriaProofOfWork = z.infer<typeof CambriaProofOfWorkSchema>;

export interface CambriaDashboard {
  user: z.infer<typeof CambriaUserSchema>;
  loot: CambriaLootScore;
  points: CambriaPoints;
  quests: CambriaQuest[];
}

export interface CambriaClaimResult {
  status: 'claimed' | 'already_claimed' | 'not_eligible' | 'empty' | 'disabled';
  loot: CambriaLootScore;
  claim?: unknown;
}

export interface CambriaHttpRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: string;
}

export interface CambriaHttpResponse {
  status: number;
  body: unknown;
  setCookies?: string[];
  headers?: Record<string, string>;
}

export type CambriaTransport = (input: CambriaHttpRequest) => Promise<CambriaHttpResponse>;

export interface CambriaSessionSeed {
  address: string;
  userId: string;
  customerToken: string;
  refreshToken?: string;
  identityToken?: string;
  cookies: Array<{ name: string; value: string }>;
}

export class CambriaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'CambriaApiError';
  }
}

export class CambriaInviteRequiredError extends Error {
  constructor() {
    super('Cambria просит инвайт-код для первого входа');
    this.name = 'CambriaInviteRequiredError';
  }
}

export class CambriaVerificationRequiredError extends Error {
  constructor() {
    super(
      'Cambria требует Cloudflare Turnstile. Добавь CapSolver API key или заверши проверку один раз в обычном браузере.',
    );
    this.name = 'CambriaVerificationRequiredError';
  }
}

/** Official Cambria Turnstile sitekey (from lobby.cambria.gg bootstrap). */
export const CAMBRIA_TURNSTILE_SITE_KEY = '0x4AAAAAAA2MCFecQyBsUnC7';
export type CambriaTurnstileAction = 'user-auth-guard' | 'wallet-connected-guard';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

function repeatedSha256(value: string): string {
  let digest = value;
  for (let round = 0; round < 3; round++) {
    digest = createHash('sha256').update(digest, 'utf8').digest('hex');
  }
  return digest;
}

/** Mirrors Cambria's public client challenge while yielding so the desktop UI stays responsive. */
export async function solveCambriaProofOfWork(
  challenge: CambriaProofOfWork,
  maxIterations = 5_000_000,
  yieldEvery = 5_000,
): Promise<string | undefined> {
  const prefix = '0'.repeat(challenge.difficulty);
  for (let nonce = 0; nonce < maxIterations; nonce++) {
    const candidate = `${challenge.problem}-${nonce}-${challenge.salt}`;
    if (repeatedSha256(candidate).startsWith(prefix)) return `${nonce}|${challenge.salt}`;
    if (nonce > 0 && nonce % yieldEvery === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return undefined;
}

function responseMessage(body: unknown, fallback: string): { message: string; code?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { message: fallback };
  const object = body as Record<string, unknown>;
  const message =
    typeof object['message'] === 'string'
      ? object['message']
      : typeof object['error'] === 'string'
        ? object['error']
        : fallback;
  return {
    message,
    ...(typeof object['code'] === 'string' ? { code: object['code'] } : {}),
  };
}

function splitSetCookieHeader(value: string): string[] {
  return value.split(/,\s*(?=[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/g);
}

function setCookieValues(headers: Dispatcher.ResponseData['headers']): string[] {
  const raw = headers['set-cookie'];
  if (Array.isArray(raw)) return raw.flatMap(splitSetCookieHeader);
  return typeof raw === 'string' ? splitSetCookieHeader(raw) : [];
}

function normalizedResponseHeaders(
  headers: Dispatcher.ResponseData['headers'],
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') normalized[key.toLowerCase()] = value;
    else if (Array.isArray(value)) normalized[key.toLowerCase()] = value.join(', ');
  }
  return normalized;
}

function retryAfterDelay(headers: Record<string, string> | undefined): number | undefined {
  const value = headers?.['retry-after']?.trim();
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.max(1_000, Number(value) * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(1_000, timestamp - Date.now()) : undefined;
}

export function makeCambriaTransport(dispatcher: Dispatcher): CambriaTransport {
  return async (input) => {
    const response = await request(input.url, {
      method: input.method,
      dispatcher,
      headers: input.headers,
      ...(input.body !== undefined ? { body: input.body } : {}),
      headersTimeout: 20_000,
      bodyTimeout: 30_000,
    });
    const text = await response.body.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    const cookies = setCookieValues(response.headers);
    return {
      status: response.statusCode,
      body,
      headers: normalizedResponseHeaders(response.headers),
      ...(cookies.length > 0 ? { setCookies: cookies } : {}),
    };
  };
}

export function buildCambriaSiweMessage(
  address: string,
  nonce: string,
  issuedAt = new Date().toISOString(),
): string {
  return `lobby.cambria.gg wants you to sign in with your Ethereum account:
${address}

By signing, you are proving you own this wallet and logging in. This does not initiate a transaction or cost any fees.

URI: https://lobby.cambria.gg
Version: 1
Chain ID: 2741
Nonce: ${nonce}
Issued At: ${issuedAt}
Resources:
- https://privy.io`;
}

function normalizeInviteCode(value: string | undefined): string | undefined {
  const code = value?.trim().toLowerCase();
  if (!code) return undefined;
  if (!/^[a-z0-9]{4,32}$/.test(code)) throw new Error('Некорректный инвайт-код Cambria');
  return code;
}

export class CambriaClient {
  private readonly cookies = new Map<string, string>();
  private customerToken: string | undefined;
  private userId: string | undefined;
  private authenticatedAddress: string | undefined;
  private privyAuth: z.infer<typeof PrivyAuthSchema> | undefined;
  private readonly analyticsId = randomUUID();
  private readonly lobbyTransport: CambriaTransport;

  constructor(
    private readonly config: CambriaConfig,
    private readonly transport: CambriaTransport,
    lobbyTransport?: CambriaTransport,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {
    this.lobbyTransport = lobbyTransport ?? transport;
  }

  private absorbCookies(values: string[] | undefined): void {
    for (const value of values ?? []) {
      const pair = value.split(';', 1)[0];
      const separator = pair?.indexOf('=') ?? -1;
      if (!pair || separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const content = pair.slice(separator + 1).trim();
      if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) this.cookies.set(name, content);
    }
  }

  private seedPrivyCookies(auth: z.infer<typeof PrivyAuthSchema>): void {
    this.customerToken = auth.token;
    this.userId = auth.user.id;
    const values: Record<string, string | undefined> = {
      'privy-token': auth.token,
      'privy-refresh-token': auth.refresh_token,
      'privy-id-token': auth.identity_token,
      'privy-session': 't',
      [`privy-${auth.user.id}-token`]: auth.token,
      [`privy-${auth.user.id}-refresh-token`]: auth.refresh_token,
      [`privy-${auth.user.id}-id-token`]: auth.identity_token,
      [`privy-${auth.user.id}-session`]: 't',
    };
    for (const [name, value] of Object.entries(values)) {
      if (value) this.cookies.set(name, value);
    }
  }

  private cookieHeader(): string {
    return Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join('; ');
  }

  private async send(
    url: string,
    method: HttpMethod,
    body?: unknown,
    privy = false,
  ): Promise<unknown> {
    const cookie = this.cookieHeader();
    const headers: Record<string, string> = {
      accept: 'application/json',
      origin: this.config.lobbyUrl,
      referer: `${this.config.lobbyUrl}/`,
      'user-agent': BROWSER_USER_AGENT,
      'sec-ch-ua': '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': privy ? 'same-site' : 'same-site',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(privy
        ? {
            'privy-app-id': this.config.privyAppId,
            'privy-ca-id': this.analyticsId,
            'privy-client': this.config.privyClient,
          }
        : {}),
    };
    const transport = privy ? this.transport : this.lobbyTransport;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await transport({
        url,
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      this.absorbCookies(response.setCookies);
      if (response.status >= 200 && response.status < 300) return response.body;
      if (!privy && response.status === 511) throw new CambriaVerificationRequiredError();

      const retryAfterMs = retryAfterDelay(response.headers);
      // Retry only a short, explicit server pause. Waiting 45-120 seconds inside
      // an HTTP request leaves the desktop UI spinning and can overlap with the
      // user's next action. Longer limits are returned to the background scheduler.
      if (response.status === 429 && attempt < 1 && retryAfterMs && retryAfterMs <= 10_000) {
        await this.sleep(retryAfterMs);
        continue;
      }
      const fallback = `Cambria HTTP ${response.status}`;
      const detail = responseMessage(response.body, fallback);
      throw new CambriaApiError(
        detail.message,
        response.status,
        detail.code,
        response.status === 429 ? Math.max(180_000, retryAfterMs ?? 0) : retryAfterMs,
      );
    }
    throw new CambriaApiError(
      'Cambria временно ограничила частоту запросов',
      429,
      undefined,
      180_000,
    );
  }

  private privy(path: string, body: unknown): Promise<unknown> {
    return this.send(`${this.config.privyApiBase}${path}`, 'POST', body, true);
  }

  private lobby(path: string, method: HttpMethod = 'GET', body?: unknown): Promise<unknown> {
    return this.send(`${this.config.apiBase}${path}`, method, body);
  }

  async authenticate(signer: GigaverseLoginSigner): Promise<void> {
    const address = signer.account.address;
    const initialized = z
      .object({ nonce: z.string().min(8) })
      .parse(await this.privy('/api/v1/siwe/init', { address }));
    const message = buildCambriaSiweMessage(address, initialized.nonce);
    const signature = await signer.signMessage({ message });
    const auth = PrivyAuthSchema.parse(
      await this.privy('/api/v1/siwe/authenticate', {
        signature,
        message,
        chainId: 'eip155:2741',
        walletClientType: null,
        connectorType: null,
        mode: 'login-or-sign-up',
      }),
    );
    this.privyAuth = auth;
    this.seedPrivyCookies(auth);
    this.authenticatedAddress = address;
  }

  useBrowserSession(address: string): void {
    if (!/^0x[a-f0-9]{40}$/i.test(address)) throw new Error('Некорректный адрес Cambria-сессии');
    this.authenticatedAddress = address;
  }

  /**
   * Submit a solved Cloudflare Turnstile token to Cambria.
   * Official actions: user-auth-guard | wallet-connected-guard.
   */
  async verifyTurnstile(
    token: string,
    action: CambriaTurnstileAction = 'user-auth-guard',
  ): Promise<void> {
    const trimmed = token.trim();
    if (!trimmed) throw new Error('Пустой Turnstile-токен Cambria');
    await this.lobby('/turnstile/verify', 'POST', { token: trimmed, action });
  }

  /**
   * Finish the lobby server session: optional Turnstile (CapSolver) + POW.
   * When Cambria returns 511, CapSolver is used if solveTurnstile is provided;
   * otherwise CambriaVerificationRequiredError starts the external browser flow.
   */
  async establishServerSession(options?: {
    solveTurnstile?: () => Promise<string>;
  }): Promise<void> {
    const runPowAndVerify = async (): Promise<void> => {
      const challenge = CambriaProofOfWorkSchema.parse(
        await this.lobby('/auth/pow?endpoint=verifySignature'),
      );
      const solution = await solveCambriaProofOfWork(challenge);
      if (!solution) {
        throw new Error('Cambria не приняла proof-of-work после 5 000 000 попыток');
      }
      await this.lobby('/auth/pow', 'POST', {
        solution,
        difficulty: challenge.difficulty,
        challengeId: challenge.challengeId,
      });
      await this.lobby(`/auth/verify?powChallengeId=${encodeURIComponent(challenge.challengeId)}`);
    };

    const passTurnstile = async (): Promise<void> => {
      if (!options?.solveTurnstile) throw new CambriaVerificationRequiredError();
      const token = await options.solveTurnstile();
      try {
        await this.verifyTurnstile(token, 'user-auth-guard');
      } catch (error) {
        // Some sessions only accept the wallet guard after Privy SIWE.
        if (!(error instanceof CambriaApiError) || ![400, 401, 428].includes(error.status)) {
          throw error;
        }
        await this.verifyTurnstile(token, 'wallet-connected-guard');
      }
    };

    // Proactively clear Turnstile when CapSolver is available — avoids a failed POW round-trip.
    if (options?.solveTurnstile) {
      try {
        await passTurnstile();
      } catch (error) {
        if (!(error instanceof CambriaApiError) || ![400, 401, 409].includes(error.status)) {
          // Keep going: session might already be verified or Turnstile may be optional right now.
          if (error instanceof CambriaVerificationRequiredError) throw error;
        }
      }
    }

    try {
      await runPowAndVerify();
    } catch (error) {
      const needsTurnstile =
        error instanceof CambriaVerificationRequiredError ||
        (error instanceof CambriaApiError && [401, 428, 511].includes(error.status));
      if (!needsTurnstile) throw error;
      await passTurnstile();
      await runPowAndVerify();
    }
  }

  sessionSeed(): CambriaSessionSeed {
    const auth = this.privyAuth;
    const address = this.authenticatedAddress;
    if (!auth || !address || !this.customerToken || !this.userId) {
      throw new Error('Cambria не завершила Privy-авторизацию');
    }
    return {
      address,
      userId: this.userId,
      customerToken: this.customerToken,
      ...(auth.refresh_token ? { refreshToken: auth.refresh_token } : {}),
      ...(auth.identity_token ? { identityToken: auth.identity_token } : {}),
      cookies: Array.from(this.cookies, ([name, value]) => ({ name, value })),
    };
  }

  private async currentUser(): Promise<z.infer<typeof CambriaUserSchema>> {
    return CambriaUserSchema.parse(await this.lobby('/user/current'));
  }

  private async availableUsername(address: string): Promise<string> {
    const stem = `ah${address
      .toLowerCase()
      .slice(-10)
      .replace(/[^a-f0-9]/g, '')}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `${stem}${attempt || ''}`;
      const result = z
        .object({ available: z.boolean() })
        .parse(await this.lobby(`/user/username?username=${encodeURIComponent(candidate)}`));
      if (result.available) return candidate;
    }
    throw new Error('Cambria не приняла автоматически созданное имя');
  }

  async ensureOnboarded(inviteCode?: string): Promise<z.infer<typeof CambriaUserSchema>> {
    try {
      return await this.currentUser();
    } catch (error) {
      if (!(error instanceof CambriaApiError) || error.status !== 404) throw error;
    }
    const code = normalizeInviteCode(inviteCode);
    if (!code) throw new CambriaInviteRequiredError();
    const authAddress = this.authenticatedAddress ?? '';
    if (!/^0x[a-f0-9]{40}$/i.test(authAddress)) {
      throw new Error('Cambria не вернула адрес авторизованного Abstract-аккаунта');
    }
    const username = await this.availableUsername(authAddress);
    await this.lobby('/user/username', 'PUT', {
      display_name_type: 'name',
      player_name: username,
    });
    await this.lobby('/user/character', 'PUT', {
      character_layers: ['color3', 'eyes1', 'hair6', 'palette_8'],
    });
    await this.lobby('/invitation/validate', 'POST', { code });
    await this.lobby('/user/update-linked-wallets', 'PUT', {});
    return await this.currentUser();
  }

  async dashboard(inviteCode?: string): Promise<CambriaDashboard> {
    const user = await this.ensureOnboarded(inviteCode);
    await this.lobby('/user/update-linked-wallets', 'PUT', {});
    // Cambria applies a tight per-session limit. Keeping these reads ordered
    // avoids turning one dashboard refresh into a burst of simultaneous calls.
    const lootRaw = await this.lobby('/scores/loot-drop');
    const pointsRaw = await this.lobby('/points/genesis/summary');
    const questsRaw = await this.lobby('/points/genesis/quests');
    return {
      user,
      loot: CambriaLootScoreSchema.parse(lootRaw),
      points: CambriaPointsSchema.parse(pointsRaw),
      quests: CambriaQuestsSchema.parse(questsRaw).quests,
    };
  }

  async claimLoot(inviteCode?: string): Promise<CambriaClaimResult> {
    await this.ensureOnboarded(inviteCode);
    await this.lobby('/user/update-linked-wallets', 'PUT', {});
    const loot = CambriaLootScoreSchema.parse(await this.lobby('/scores/loot-drop'));
    if (loot.claim) return { status: 'already_claimed', loot };
    if (!loot.claimsEnabled) return { status: 'disabled', loot };
    if (!loot.eligible) return { status: 'not_eligible', loot };
    if (loot.chests.common + loot.chests.epic + loot.chests.legendary === 0) {
      return { status: 'empty', loot };
    }
    const claim = await this.lobby('/scores/loot-drop/claim', 'POST', {
      datasetVersion: loot.datasetVersion,
    });
    return { status: 'claimed', loot, claim };
  }
}
