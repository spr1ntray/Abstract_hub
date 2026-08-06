import type { Logger } from 'pino';
import type { GigaClient } from '../api/client.js';
import type { ActionResponse, DungeonStateResponse, GearInstance } from '../api/types.js';
import { makeAction } from '../api/types.js';
import { decideMove } from '../combat/engine.js';
import { decideLoot } from '../loot/picker.js';
import type { BuildPlan } from '../loot/types.js';
import type { BattleState } from '../combat/types.js';
import { extractInventory } from '../marketplace/inventory.js';
import { present } from './presenter.js';
import { HttpError } from '../api/errors.js';

export interface RunSummary {
  rooms: number;
  picks: string[];
  died: boolean;
  /** True when a PvP opponent was detected and the bot fled rather than fighting. */
  fled: boolean;
  completed: boolean;
  /** True when this summary covers a resumed stale run (not a fresh start_run). */
  resumed?: boolean;
  initialInventory: GearInstance[];
  finalInventory: GearInstance[];
}

export async function runOne(
  client: GigaClient,
  dungeonId: 1 | 3,
  plan: BuildPlan,
  log: Logger,
): Promise<RunSummary> {
  // Log the exact request body before sending so failures show what was attempted.
  // makeAction mirrors what client.startRun() sends internally.
  const startReqBody = makeAction('start_run', { dungeonId, actionToken: '' });
  log.info({ startRunBody: startReqBody }, 'start_run: sending request');

  const res = await client.startRun(dungeonId);
  log.info({ room: 1, dungeonId }, 'run started');
  return playRunLoop(res, client, dungeonId, plan, log, { resumed: false });
}

/**
 * Resume a stale dungeon run instead of abandoning it.
 *
 * Strategy:
 *   1. Sync the actionToken the server expects.
 *   2. Make ONE probe action to convert the (limited) DungeonStateResponse
 *      into a fully-populated ActionResponse — server tells us players,
 *      lootPhase, and the canonical room number.
 *      - If the run is mid-loot we probe with pickLoot(1) (highest priority
 *        boon score will be re-decided next iteration anyway — index 1 just
 *        gives us a valid in-loot transition).
 *      - Otherwise we probe with `move('paper')` — neutral, always legal in
 *        combat, lets the server resolve the round.
 *   3. Hand the response to playRunLoop which finishes the run the same
 *      way runOne would.
 *
 * Throws when the probe action fails and the caller (main.ts) must decide
 * whether to flee/skip the account.
 */
export async function resumeRun(
  client: GigaClient,
  dungeonId: 1 | 3,
  plan: BuildPlan,
  log: Logger,
  state: DungeonStateResponse,
): Promise<RunSummary> {
  const tok =
    typeof state.actionToken === 'number' ? String(state.actionToken) : (state.actionToken ?? '');
  client.setLastActionToken(tok);

  // Decide probe action from whatever shape we can read out of the stale state.
  const probe = pickProbeAction(state);
  log.info({ probe, actionToken: tok }, 'resuming stale run with probe action');

  let res: ActionResponse;
  try {
    res = probe === 'loot' ? await client.pickLoot(1) : await client.move('paper');
  } catch (e) {
    // The stale state hinted wrongly (e.g. we tried `move` but server is in
    // loot phase). Flip the probe once and try again.
    if (e instanceof HttpError) {
      log.warn(
        { err: e, retryWith: probe === 'loot' ? 'move(paper)' : 'pickLoot(1)' },
        'probe failed — flipping action',
      );
      res = probe === 'loot' ? await client.move('paper') : await client.pickLoot(1);
    } else {
      throw e;
    }
  }

  return playRunLoop(res, client, dungeonId, plan, log, { resumed: true });
}

/**
 * Inspect the stale dungeonState and choose between a combat probe (`move`)
 * and a loot probe (`pickLoot`). We probe both `state.run` directly and
 * `state.run.data.run` because the API has been observed using both shapes.
 */
function pickProbeAction(state: DungeonStateResponse): 'move' | 'loot' {
  const candidates: Record<string, unknown>[] = [];
  const run = state.run as unknown;
  if (run && typeof run === 'object') {
    candidates.push(run as Record<string, unknown>);
    const data = (run as Record<string, unknown>)['data'];
    if (data && typeof data === 'object') {
      const inner = (data as Record<string, unknown>)['run'];
      if (inner && typeof inner === 'object') candidates.push(inner as Record<string, unknown>);
    }
  }
  for (const c of candidates) {
    if (c['lootPhase'] === true) return 'loot';
  }
  return 'move';
}

/**
 * Shared run loop — given a starting ActionResponse, play the run to
 * completion / death / PvP flee and return the summary.
 *
 * Used by both runOne (after start_run) and resumeRun (after a probe
 * action against an existing stale run).
 */
async function playRunLoop(
  startRes: ActionResponse,
  client: GigaClient,
  dungeonId: 1 | 3,
  plan: BuildPlan,
  log: Logger,
  opts: { resumed: boolean },
): Promise<RunSummary> {
  let res = startRes;

  const summary: RunSummary = {
    rooms: 0,
    picks: [],
    died: false,
    fled: false,
    completed: false,
    resumed: opts.resumed,
    initialInventory: extractInventory(res),
    finalInventory: [],
  };

  const PLAYER_ID_RE = /^0x[a-fA-F0-9]{40}$/;

  const seenGearIds = new Set<string>(summary.initialInventory.map((g) => g.docId));
  let lastInvaderCount = res.data.entity.data.roomInvaderItemsEarned.length;

  function announceNewDrops(current: ActionResponse, room: number): void {
    const currentGear = extractInventory(current);
    for (const g of currentGear) {
      if (!seenGearIds.has(g.docId)) {
        seenGearIds.add(g.docId);
        present.itemDropped(room, {
          name: `item#${g.GAME_ITEM_ID_CID}`,
          rarity: g.RARITY_CID,
          docId: g.docId,
        });
      }
    }
    const invader = current.data.entity.data.roomInvaderItemsEarned;
    if (invader.length > lastInvaderCount) {
      for (let i = lastInvaderCount; i < invader.length; i++) {
        present.itemDropped(room, parseInvaderItem(invader[i]));
      }
      lastInvaderCount = invader.length;
    }
  }

  // Safety bound — never spin forever even if server state is weird
  const MAX_STEPS = 500;
  for (let step = 0; step < MAX_STEPS; step++) {
    summary.rooms = res.data.entity.ROOM_NUM_CID;

    if (res.data.entity.COMPLETE_CID) {
      summary.completed = true;
      log.info({ rooms: summary.rooms }, 'run complete');
      present.runComplete(summary.rooms);
      break;
    }

    if (res.data.run.lootPhase && res.data.run.lootOptions.length > 0) {
      const state = mkBattleState(res, dungeonId);
      const idx = decideLoot(res.data.run.lootOptions, state, plan);
      const picked = res.data.run.lootOptions[idx - 1];
      const boon = picked?.boonTypeString ?? 'unknown';
      log.info({ idx, boon, room: summary.rooms }, 'loot pick');
      present.lootPick(boon, summary.rooms);
      summary.picks.push(boon);
      await client.lootThinking();
      res = await client.pickLoot(idx);
      announceNewDrops(res, summary.rooms);
      continue;
    }

    const state = mkBattleState(res, dungeonId);

    if (process.env.GIGABOT_FLEE_PVP === 'true') {
      const enemyId = state.enemy.id ?? '';
      if (PLAYER_ID_RE.test(enemyId)) {
        log.warn({ room: summary.rooms, enemyId }, 'PvP opponent detected — fleeing');
        present.runFledPvp(summary.rooms);
        res = await client.flee();
        summary.fled = true;
        break;
      }
    }

    const moveName = decideMove(state);
    log.info({ room: summary.rooms, move: moveName }, 'move');

    const myHpBefore = state.me.health.current;

    res = await client.move(moveName);
    announceNewDrops(res, summary.rooms);

    const myHpAfter = res.data.run.players[0]?.health.current ?? 0;
    const enemyHpAfter = res.data.run.players[1]?.health.current ?? 0;
    const enemyMove = res.data.run.players[1]?.lastMove ?? '';
    present.combatStep(summary.rooms, moveName, enemyMove, myHpBefore, myHpAfter, enemyHpAfter);

    if (myHpAfter <= 0) {
      summary.died = true;
      log.warn({ room: summary.rooms }, 'died');
      present.runDied(summary.rooms);
      const dropCount = res.data.entity.data.roomInvaderItemsEarned.length;
      present.runDrops(dropCount);
      break;
    }
  }

  summary.finalInventory = extractInventory(res);

  if (!summary.died) {
    const dropCount = res.data.entity.data.roomInvaderItemsEarned.length;
    present.runDrops(dropCount);
  }

  return summary;
}

/**
 * Pull whatever identifying fields the server returned for a room-invader item.
 * The exact shape varies (server didn't typed this for us), so probe common
 * field names defensively.
 */
function parseInvaderItem(entry: unknown): {
  name: string;
  rarity?: number;
  docId?: string;
} {
  if (entry == null || typeof entry !== 'object') {
    return { name: typeof entry === 'string' ? entry : 'unknown' };
  }
  const o = entry as Record<string, unknown>;
  const itemId =
    (typeof o.GAME_ITEM_ID_CID === 'number' && o.GAME_ITEM_ID_CID) ||
    (typeof o.itemId === 'number' && o.itemId) ||
    (typeof o.id === 'string' && o.id);
  const name =
    (typeof o.NAME === 'string' && o.NAME) ||
    (typeof o.name === 'string' && o.name) ||
    (itemId ? `item#${itemId}` : 'unknown item');
  const rarity =
    typeof o.RARITY_CID === 'number'
      ? o.RARITY_CID
      : typeof o.rarity === 'number'
        ? o.rarity
        : undefined;
  const docId =
    typeof o.docId === 'string' ? o.docId : typeof o._id === 'string' ? o._id : undefined;
  return { name, ...(rarity !== undefined ? { rarity } : {}), ...(docId ? { docId } : {}) };
}

function mkBattleState(res: ActionResponse, dungeonId: 1 | 3): BattleState {
  const players = res.data.run.players;
  const me = players[0];
  const enemy = players[1];
  if (!me || !enemy) throw new Error('runOne: missing players in response');
  return {
    me,
    enemy,
    room: res.data.entity.ROOM_NUM_CID,
    dungeonId,
  };
}
