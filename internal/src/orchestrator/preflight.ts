/**
 * Pre-flight diagnostics for Gigaverse.
 *
 * Contains pure formatting helpers (testable without network) and the
 * orchestrated pre-flight check that runs after login and before the run loop.
 */

import type { Logger } from 'pino';
import type {
  GameAccount,
  DungeonStateResponse,
  DungeonTodayResponse,
  EnergyState,
} from '../api/types.js';
import type { GigaClient } from '../api/client.js';
import type { BuildPlan, LootOption } from '../loot/types.js';
import type { BattleState, PlayerState } from '../combat/types.js';
import { decideLoot } from '../loot/picker.js';

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable)
// ---------------------------------------------------------------------------

export interface AccountSummaryFields {
  username: string | undefined;
  canEnterGame: boolean | undefined;
  hasAcceptedLegal: boolean | undefined;
  noobId: string | undefined;
  noobLevel: number | undefined;
  expiresAt: number;
}

/**
 * Extract the fields needed for the login summary line from a gameAccount object.
 * Pure function — no I/O.
 */
export function extractAccountSummaryFields(
  gameAccount: GameAccount,
  expiresAt: number,
): AccountSummaryFields {
  const noob = gameAccount.noob ?? null;
  return {
    username: typeof gameAccount.username === 'string' ? gameAccount.username : undefined,
    canEnterGame:
      typeof gameAccount.canEnterGame === 'boolean' ? gameAccount.canEnterGame : undefined,
    hasAcceptedLegal:
      typeof gameAccount.hasAcceptedLegal === 'boolean' ? gameAccount.hasAcceptedLegal : undefined,
    noobId: noob && typeof noob._id === 'string' ? noob._id : undefined,
    noobLevel: noob && typeof noob.LEVEL_CID === 'number' ? noob.LEVEL_CID : undefined,
    expiresAt,
  };
}

/**
 * Format the one-line login summary shown immediately after a successful auth.
 *
 * Example output:
 *   username=player_one, canEnterGame=true, hasAcceptedLegal=true,
 *   noob=#75769 (LEVEL_CID=1), expiresAt=2026-05-26 19:22 UTC
 */
export function formatLoginSummary(fields: AccountSummaryFields): string {
  const expiryStr =
    new Date(fields.expiresAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  const noobStr =
    fields.noobId !== undefined
      ? `#${fields.noobId}${fields.noobLevel !== undefined ? ` (LEVEL_CID=${fields.noobLevel})` : ''}`
      : '(not minted)';

  return [
    `username=${fields.username ?? '?'}`,
    `canEnterGame=${fields.canEnterGame ?? '?'}`,
    `hasAcceptedLegal=${fields.hasAcceptedLegal ?? '?'}`,
    `noob=${noobStr}`,
    `expiresAt=${expiryStr}`,
  ].join(', ');
}

// ---------------------------------------------------------------------------
// Preflight error — actionable, non-retryable
// ---------------------------------------------------------------------------

/**
 * Thrown when pre-flight detects an account that cannot play.
 * Caught in main.ts to print a clear actionable message.
 */
export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreflightError';
  }
}

// ---------------------------------------------------------------------------
// Orchestrated checks
// ---------------------------------------------------------------------------

/**
 * Log the login summary and bail out if the account cannot enter the game.
 *
 * Should be called immediately after loginToGigaverse() returns.
 *
 * @throws PreflightError if canEnterGame is false or the noob NFT is missing.
 */
export function checkAccountReadiness(
  gameAccount: GameAccount,
  expiresAt: number,
  accountName: string,
  log: Logger,
): void {
  const fields = extractAccountSummaryFields(gameAccount, expiresAt);
  log.info({ account: accountName }, `login: ${formatLoginSummary(fields)}`);

  const canEnter = fields.canEnterGame;
  const hasNoob = fields.noobId !== undefined;
  const hasLegal = fields.hasAcceptedLegal;

  // Only bail if we have a definitive false — undefined means the field was
  // absent from the server response (older API version), so we let it through.
  if (canEnter === false || !hasNoob) {
    const lines = [
      `[!] Account ${fields.username ?? accountName} cannot enter game.`,
      `    canEnterGame: ${canEnter ?? '(unknown)'}`,
      `    noob: ${hasNoob ? `#${fields.noobId}` : '(not minted)'}`,
      `    hasAcceptedLegal: ${hasLegal ?? '(unknown)'}`,
      `    Action: open gigaverse.io in a browser using this account, accept ToS, mint a noob NFT.`,
    ];
    throw new PreflightError(lines.join('\n'));
  }
}

/**
 * Log dungeon state (active run check) as human-readable info.
 * Best-effort — never throws.
 */
export function logDungeonState(
  state: DungeonStateResponse,
  accountName: string,
  log: Logger,
): void {
  try {
    const run = state.run ?? state.entity ?? null;
    if (run && typeof run === 'object') {
      const room = typeof run.ROOM_NUM_CID === 'number' ? run.ROOM_NUM_CID : '?';
      const complete = run.COMPLETE_CID === true ? 'complete' : 'active';
      log.info({ account: accountName }, `dungeon state: run is ${complete} at room ${room}`);
    } else {
      log.info({ account: accountName }, 'dungeon state: idle (no active run)');
    }
  } catch {
    // Silently skip — diagnostics must not crash the bot
  }
}

// ---------------------------------------------------------------------------
// Health-check
// ---------------------------------------------------------------------------

/** Per-step status reported by runHealthCheck — drives the presenter UI. */
export type HealthStatus = 'ok' | 'warn' | 'fail';

export interface HealthStep {
  /** Short label for what was checked, e.g. "Сессия", "Энергия", "Активный ран". */
  label: string;
  status: HealthStatus;
  /** Human-readable detail line shown next to the label. */
  detail: string;
}

export interface HealthCheckResult {
  /** True when the account passed every critical account/session check. */
  ready: boolean;
  /** True when a fresh dungeon run is worth attempting after pre-dungeon work. */
  canRunDungeon: boolean;
  steps: HealthStep[];
  /**
   * When a stale dungeon run was detected, the raw state response is forwarded
   * to the caller so it can call `resumeRun()` instead of abandoning. Absent
   * when there is no active run.
   */
  staleRun?: DungeonStateResponse;
}

/** Energy needed per dungeon run — keep in sync with main.ts. */
const ENERGY_PER_RUN = 40;

/**
 * Try to pick up loot still waiting on the server before we abandon a stale
 * run. Without this we lose every UpgradeRock_ATK / armor / HP boon that was
 * earned but not yet picked — exactly what gigaverse's own UI warns about
 * ("WARNING: You will lose any unused items").
 *
 * Best-effort: if the response shape doesn't expose lootOptions, or the pick
 * fails, we fall through and the caller will flee anyway.
 */
async function pickPendingLootBeforeAbandon(
  client: GigaClient,
  state: DungeonStateResponse,
  plan: BuildPlan,
  log: Logger,
): Promise<{ pickedCount: number; pickedBoons: string[] }> {
  const run = state.run as Record<string, unknown> | null | undefined;
  if (!run || typeof run !== 'object') return { pickedCount: 0, pickedBoons: [] };

  // Some shapes nest the gameplay state under `.data.run`, others put
  // lootPhase / lootOptions directly on the top-level run object. Probe both.
  const candidates: Record<string, unknown>[] = [run];
  const dataObj = run['data'];
  if (dataObj && typeof dataObj === 'object') {
    const dataRun = (dataObj as Record<string, unknown>)['run'];
    if (dataRun && typeof dataRun === 'object') candidates.push(dataRun as Record<string, unknown>);
  }

  const pickedBoons: string[] = [];
  // Server may queue several picks in sequence; loop a few times but cap so
  // we never spin forever on a malformed response.
  for (let attempt = 0; attempt < 4; attempt++) {
    let lootOptions: unknown;
    let lootPhase = false;
    for (const c of candidates) {
      if (c['lootPhase'] === true) lootPhase = true;
      if (Array.isArray(c['lootOptions'])) lootOptions = c['lootOptions'];
    }
    if (!lootPhase || !Array.isArray(lootOptions) || lootOptions.length === 0) break;

    try {
      const idx = decideLoot(lootOptions as LootOption[], synthesizeBattleStateFromRun(run), plan);
      const res = await client.pickLoot(idx);
      const picked = (lootOptions as LootOption[])[idx - 1];
      const boon = picked?.boonTypeString ?? 'unknown';
      pickedBoons.push(boon);
      log.info({ idx, boon }, 'salvaged loot before abandon');

      // After pickLoot the server returns an ActionResponse. Re-probe its
      // run/lootPhase fields for any follow-up loot waiting in the queue.
      candidates.length = 0;
      const next = res.data?.run as unknown;
      if (next && typeof next === 'object') candidates.push(next as Record<string, unknown>);
    } catch (e) {
      log.warn({ err: e }, 'pickPendingLoot failed — falling through to flee');
      break;
    }
  }
  return { pickedCount: pickedBoons.length, pickedBoons };
}

/**
 * Build a minimal BattleState from a stale dungeon-state run object so that
 * decideLoot can score boons. The run snapshot from /api/game/dungeon/state
 * is missing combat fields the picker normally depends on; we substitute
 * neutral defaults so priority-based scoring still works (rock/scissor boons
 * still beat paper, etc).
 */
function synthesizeBattleStateFromRun(run: Record<string, unknown>): BattleState {
  const stat = {
    startingATK: 1,
    startingDEF: 0,
    currentATK: 1,
    currentDEF: 0,
    currentCharges: 1,
    maxCharges: 1,
  };
  const player: PlayerState = {
    id: 'me',
    rock: { ...stat },
    paper: { ...stat },
    scissor: { ...stat },
    health: { current: 1, starting: 1, currentMax: 1, startingMax: 1 },
    shield: { current: 0, starting: 0 },
    lastMove: '',
    thisPlayerWin: false,
    otherPlayerWin: false,
    statusEffects: [],
    activeEffects: [],
  };
  const enemy: PlayerState = { ...player, id: 'enemy' };
  const roomNum = typeof run['ROOM_NUM_CID'] === 'number' ? run['ROOM_NUM_CID'] : 1;
  return { me: player, enemy, room: roomNum, dungeonId: 1 };
}

/**
 * Safely close out a stale dungeon run.
 *
 * 1. Sync the client's actionToken from the server-supplied value.
 * 2. Salvage any loot still in lootPhase (so we don't trip gigaverse's
 *    "unused items will be lost" warning).
 * 3. flee() to close the run.
 *
 * Returns true on success (state is clean), false if anything failed.
 */
export async function safelyAbandonRun(
  client: GigaClient,
  state: DungeonStateResponse,
  plan: BuildPlan,
  log: Logger,
): Promise<{ ok: boolean; salvagedBoons: string[]; error?: string }> {
  const tok =
    typeof state.actionToken === 'number' ? String(state.actionToken) : (state.actionToken ?? '');
  client.setLastActionToken(tok);

  const { pickedBoons } = await pickPendingLootBeforeAbandon(client, state, plan, log);

  try {
    await client.flee();
    return { ok: true, salvagedBoons: pickedBoons };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, salvagedBoons: pickedBoons, error: msg };
  }
}

/** Format a one-line summary of energy state for the presenter. */
function summarizeEnergy(e: EnergyState): { runs: number; status: HealthStatus; detail: string } {
  const runs = Math.floor(e.energyValue / ENERGY_PER_RUN);
  const status: HealthStatus =
    runs === 0 ? 'warn' : e.energyValue < e.maxEnergy * 0.3 ? 'warn' : 'ok';
  return {
    runs,
    status,
    detail: `${e.energyValue}/${e.maxEnergy} (хватит на ${runs} ран)`,
  };
}

/**
 * Probe every shape the dungeon-state endpoint has been observed to use.
 * Returns the inner run object if anything looks like an active run.
 *
 * Observed shapes: `{run: {...}}`, `{entity: {...}}`, `{entities: [{...}]}`,
 * and `{data: {run: {...}}}`. The 2026-05-31 incident report showed that
 * `state.run` was null even when start_run failed with a server-supplied
 * actionToken — meaning the run is hidden under one of the alternative keys.
 */
export function extractActiveRun(state: DungeonStateResponse): Record<string, unknown> | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const obj = state as Record<string, unknown>;
  if (obj['run'] && typeof obj['run'] === 'object') return obj['run'] as Record<string, unknown>;
  if (obj['entity'] && typeof obj['entity'] === 'object')
    return obj['entity'] as Record<string, unknown>;
  if (Array.isArray(obj['entities']) && obj['entities'].length > 0) {
    const first = obj['entities'][0];
    if (first && typeof first === 'object') return first as Record<string, unknown>;
  }
  if (obj['data'] && typeof obj['data'] === 'object') {
    const data = obj['data'] as Record<string, unknown>;
    if (data['run'] && typeof data['run'] === 'object')
      return data['run'] as Record<string, unknown>;
  }
  return undefined;
}

/** Pull the dungeon list out of whatever shape the server returns today. */
function extractDungeonList(today: unknown): Array<Record<string, unknown>> {
  if (!today || typeof today !== 'object') return [];
  const obj = today as Record<string, unknown>;
  if (Array.isArray(obj.dungeons)) return obj.dungeons as Array<Record<string, unknown>>;
  if (Array.isArray(obj.entities)) return obj.entities as Array<Record<string, unknown>>;
  if (Array.isArray(obj.data)) return obj.data as Array<Record<string, unknown>>;
  const data = obj.data;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.dungeons)) return d.dungeons as Array<Record<string, unknown>>;
    if (Array.isArray(d.entities)) return d.entities as Array<Record<string, unknown>>;
  }
  return [];
}

/** Format a one-line summary for the dungeon-today step. */
function summarizeDungeonToday(
  today: DungeonTodayResponse,
  dungeonId: number,
): { status: HealthStatus; detail: string } {
  const dungeons = extractDungeonList(today);
  if (dungeons.length === 0) {
    // No data is a soft warn — start_run will surface the real reason if the
    // dungeon is actually unavailable. We've seen the endpoint return shapes
    // we don't recognise; better to let the run attempt proceed than block.
    return { status: 'warn', detail: 'сервер не вернул список — пробую стартовать' };
  }
  const ids = dungeons
    .map((d) => (typeof d.dungeonId === 'number' ? d.dungeonId : undefined))
    .filter((id): id is number => id !== undefined);
  if (ids.length === 0) {
    return {
      status: 'warn',
      detail: `вернул ${dungeons.length} запис(ей), но без dungeonId — пробую стартовать`,
    };
  }
  if (!ids.includes(dungeonId)) {
    return {
      status: 'fail',
      detail: `данж ${dungeonId} не доступен сегодня (есть: ${ids.join(', ')})`,
    };
  }
  return { status: 'ok', detail: `${ids.join(', ')} — выбран ${dungeonId}` };
}

/**
 * Run the full pre-play health check for an account. Each step accumulates
 * into `steps[]`. `ready` is account/session readiness; `canRunDungeon` is
 * checked again after the zero/low-energy node reward phase.
 *
 * The order matters: cheap checks first, network-dependent ones last; if
 * something CRITICAL fails we still keep going so the final report shows
 * the full picture for the user.
 */
export async function runHealthCheck(opts: {
  client: GigaClient;
  agwAddress: string;
  dungeonId: 1 | 3;
  gameAccount: GameAccount;
  expiresAt: number;
  accountName: string;
  log: Logger;
}): Promise<HealthCheckResult> {
  const { client, agwAddress, dungeonId, gameAccount, expiresAt, accountName, log } = opts;
  const steps: HealthStep[] = [];
  let ready = true;
  let canRunDungeon = true;

  // 1. Account readiness (canEnterGame, noob NFT, legal)
  const acct = extractAccountSummaryFields(gameAccount, expiresAt);
  if (acct.canEnterGame === false || acct.noobId === undefined) {
    steps.push({
      label: 'Аккаунт',
      status: 'fail',
      detail:
        acct.canEnterGame === false
          ? 'canEnterGame=false — примите ToS и сминтите noob NFT на gigaverse.io'
          : 'noob NFT не сминтен — зайдите на gigaverse.io',
    });
    ready = false;
    canRunDungeon = false;
  } else {
    const who = acct.username ? `@${acct.username}` : `noob #${acct.noobId}`;
    steps.push({ label: 'Аккаунт', status: 'ok', detail: `${who}, lvl ${acct.noobLevel ?? '?'}` });
  }

  // 2. Internal game-session expiry
  const msToExpiry = expiresAt - Date.now();
  if (msToExpiry <= 0) {
    steps.push({ label: 'Сессия', status: 'fail', detail: 'истекла — нужен повторный вход' });
    ready = false;
    canRunDungeon = false;
  } else {
    const hours = Math.round(msToExpiry / 3_600_000);
    const status: HealthStatus = hours < 2 ? 'warn' : 'ok';
    steps.push({
      label: 'Сессия',
      status,
      detail: hours < 24 ? `истекает через ${hours}ч` : `истекает через ${Math.round(hours / 24)}д`,
    });
  }

  // 3. Energy — blocks fresh dungeons when low, but not zero-cost chest/node attempts.
  let energySnapshot: EnergyState | undefined;
  try {
    energySnapshot = await client.getEnergy(agwAddress);
    const e = summarizeEnergy(energySnapshot);
    steps.push({ label: 'Энергия', status: e.status, detail: e.detail });
    if (e.runs === 0) canRunDungeon = false;
  } catch (e) {
    steps.push({
      label: 'Энергия',
      status: 'warn',
      detail: `не удалось получить — ${e instanceof Error ? e.message : String(e)}; перепроверю после кувшинов`,
    });
    canRunDungeon = false;
  }

  // 4. Active run detection (informational only).
  // We DO NOT abandon here any more — the caller will resume the run via
  // `resumeRun()` so accumulated loot isn't lost. The raw state is forwarded
  // out via `result.staleRun` so main.ts can drive that resume.
  let staleRun: DungeonStateResponse | undefined;
  try {
    const state = await client.getDungeonState();
    log.debug({ account: accountName, dungeonState: state }, 'dungeon state raw');
    const run = extractActiveRun(state);
    if (run) {
      staleRun = state;
      const room = typeof run.ROOM_NUM_CID === 'number' ? run.ROOM_NUM_CID : undefined;
      const where = room !== undefined ? formatFloorRoom(room) : 'неизвестно где';
      log.warn({ account: accountName, room }, 'stale dungeon run detected — will resume');
      steps.push({
        label: 'Активный ран',
        status: 'warn',
        detail: `найден (${where}) — продолжу с этого места`,
      });
    } else {
      steps.push({ label: 'Активный ран', status: 'ok', detail: 'нет, можно стартовать' });
    }
  } catch (e) {
    steps.push({
      label: 'Активный ран',
      status: 'warn',
      detail: `проверка не удалась — ${e instanceof Error ? e.message : String(e)}`,
    });
    // Not a hard fail: start_run will surface the real issue.
  }

  // 5. Dungeon availability today
  try {
    const today = await client.getDungeonToday();
    log.debug({ account: accountName, today }, 'dungeon today raw');
    const d = summarizeDungeonToday(today, dungeonId);
    steps.push({ label: 'Данж сегодня', status: d.status, detail: d.detail });
    if (d.status === 'fail') canRunDungeon = false;
  } catch (e) {
    steps.push({
      label: 'Данж сегодня',
      status: 'warn',
      detail: `проверка не удалась — ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  return staleRun ? { ready, canRunDungeon, steps, staleRun } : { ready, canRunDungeon, steps };
}

/** Same floor/room split as presenter.splitRoom — kept local to avoid a presenter import cycle. */
function formatFloorRoom(absRoom: number): string {
  if (!Number.isFinite(absRoom) || absRoom < 1) return 'этаж 1 · комната 1';
  const z = absRoom - 1;
  return `этаж ${Math.floor(z / 4) + 1} · комната ${(z % 4) + 1}`;
}

/**
 * Log today's available dungeons and warn if the configured dungeonId is absent.
 * Best-effort — never throws.
 */
export function logDungeonToday(
  today: DungeonTodayResponse,
  configuredDungeonId: number,
  accountName: string,
  log: Logger,
): void {
  try {
    const dungeons = Array.isArray(today.dungeons) ? today.dungeons : [];
    if (dungeons.length === 0) {
      log.warn({ account: accountName }, 'dungeon today: no dungeons returned');
      return;
    }

    const summary = dungeons
      .map((d) => {
        const id = d.dungeonId ?? '?';
        const name = d.name ?? `id=${id}`;
        return `${id} (${name})`;
      })
      .join(', ');

    log.info({ account: accountName }, `available dungeons: ${summary}`);

    const available = dungeons.map((d) => d.dungeonId).filter((id) => id !== undefined);
    if (!available.includes(configuredDungeonId)) {
      log.warn(
        { account: accountName, configuredDungeonId, available },
        `dungeonId=${configuredDungeonId} is NOT in today's available dungeons — start_run will likely fail`,
      );
    }
  } catch {
    // Silently skip — diagnostics must not crash the bot
  }
}
