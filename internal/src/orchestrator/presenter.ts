/**
 * Human-readable Russian terminal output for `pnpm play`.
 *
 * This module runs ALONGSIDE pino (not instead of it). Pino continues
 * writing structured JSON to a file (or stderr in --verbose mode). The
 * presenter writes friendly, coloured Russian text to process.stderr so
 * it appears cleanly in the terminal while JSON is redirected to a file.
 *
 * All methods are no-ops when GIGABOT_PRETTY=false is set.
 */

import chalk from 'chalk';
import { AsyncLocalStorage } from 'node:async_hooks';

// ── Guard ────────────────────────────────────────────────────────────────────

/** True when human-readable output is enabled (default). */
const PRETTY = process.env.GIGABOT_PRETTY !== 'false';

/**
 * Per-account context, set by `present.withAccount(name, fn)`.
 * When two accounts run in parallel, every presenter line is prefixed with
 * `[name]` so the user can tell whose log they're reading. Without it the
 * two streams would interleave indistinguishably.
 */
const accountContext = new AsyncLocalStorage<{ name: string; color: ChalkFn }>();

type ChalkFn = (s: string) => string;
const ACCOUNT_COLORS: ChalkFn[] = [
  chalk.cyan,
  chalk.magenta,
  chalk.yellow,
  chalk.blueBright,
  chalk.greenBright,
  chalk.redBright,
];
let colorCursor = 0;

/** Allocate a stable colour for this account name (round-robin). */
function pickColor(): ChalkFn {
  const c = ACCOUNT_COLORS[colorCursor % ACCOUNT_COLORS.length]!;
  colorCursor += 1;
  return c;
}

function prefix(): string {
  const ctx = accountContext.getStore();
  if (!ctx) return '';
  return ctx.color(`[${ctx.name}] `);
}

/** Write a line to stderr — keeps it separate from any stdout piping. */
function out(line: string): void {
  if (!PRETTY) return;
  process.stderr.write(prefix() + line + '\n');
}

// ── Layout helpers ────────────────────────────────────────────────────────────

const LINE = '═'.repeat(59);
const THIN = '─'.repeat(59);

function dim(s: string): string {
  return chalk.dim(s);
}

function indent(level: number, s: string): string {
  return ' '.repeat(level * 2) + s;
}

// ── Dungeon name helper ───────────────────────────────────────────────────────

function dungeonName(id: 1 | 3): string {
  return id === 3 ? 'Underhaul (id=3)' : `Dungeon ${id === 1 ? '5000' : id}`;
}

// ── Room → "Floor X · Room Y" formatter ──────────────────────────────────────
// Gigaverse dungeons are 4 floors × 4 rooms = 16 absolute rooms.
// ROOM_NUM_CID from the server is the cumulative 1-16 index. The UI must
// always show it broken down — "Комната 5" never exists in the game.

const ROOMS_PER_FLOOR = 4;

export function splitRoom(absRoom: number): { floor: number; room: number } {
  // Defensive clamp: server returns 1-16; anything else means the API changed
  // or we got a default 0 — fall back to floor 1 room 1 rather than misreport.
  if (!Number.isFinite(absRoom) || absRoom < 1) return { floor: 1, room: 1 };
  const zeroIndexed = absRoom - 1;
  return {
    floor: Math.floor(zeroIndexed / ROOMS_PER_FLOOR) + 1,
    room: (zeroIndexed % ROOMS_PER_FLOOR) + 1,
  };
}

/** Human-readable label, e.g. "этаж 2 · комната 3" (lowercase by default). */
function roomLabel(absRoom: number, opts: { capitalize?: boolean } = {}): string {
  const { floor, room } = splitRoom(absRoom);
  const prefix = opts.capitalize ? 'Этаж' : 'этаж';
  return `${prefix} ${floor} · комната ${room}`;
}

// ── Move translation ──────────────────────────────────────────────────────────

const MOVE_RU: Record<string, string> = {
  rock: 'камень',
  paper: 'бумага',
  scissor: 'ножницы',
  '': '?',
};

function moveRu(m: string): string {
  return MOVE_RU[m] ?? m;
}

function formatNodeRewards(
  rewards: Array<{ itemId: number; amount: number; name?: string }>,
): string {
  if (rewards.length === 0) return dim('без лута');
  return rewards.map((r) => `${r.name ?? `item#${r.itemId}`} x${r.amount}`).join(', ');
}

function formatGloveSummary(s: {
  total: number;
  usable: number;
  repairable: number;
  spent: number;
  samples: string[];
}): string {
  const details = `total ${s.total}, usable ${s.usable}, repairable ${s.repairable}, spent ${s.spent}`;
  return s.samples.length > 0 ? `${details}; dur/repair ${s.samples.join(', ')}` : details;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run `fn` with a per-account presenter context. Every `present.X()` call
 * inside `fn` (or any awaited async work it spawns) automatically prefixes
 * its output with `[<name>]` in a colour unique to that account.
 */
export function withAccountPresenter<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return accountContext.run({ name, color: pickColor() }, fn);
}

export const present = {
  /**
   * Top banner — shown once at startup.
   * @param accountCount  Number of accounts being processed.
   * @param dungeon       Dungeon ID (1 = 5000, 3 = Underhaul).
   */
  banner(accountCount: number, dungeon: 1 | 3): void {
    out('');
    out(chalk.cyan(LINE));
    out(
      chalk.bold.cyan('  Abstract Hub · Gigaverse') +
        chalk.dim(` · ${accountCount} аккаунт(ов) · ${dungeonName(dungeon)}`),
    );
    out(chalk.cyan(LINE));
    out('');
  },

  /**
   * Shown at the start of each account's run loop.
   * @param name        Account label (e.g. "acc1-a1b2c3").
   * @param agwAddress  Full AGW address hex string.
   */
  accountStart(name: string, agwAddress: string): void {
    out('');
    out(
      chalk.bold.yellow(`▶ ${name}`) +
        dim(` (${agwAddress.slice(0, 10)}...${agwAddress.slice(-4)})`),
    );
  },

  /** Legacy session presentation retained for older callers. */
  jwtAccepted(agwAddress: string, expiresAt: number): void {
    const exp = new Date(expiresAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    out(
      indent(
        1,
        chalk.green('Сессия принята') +
          dim(` AGW ${agwAddress.slice(0, 10)}...${agwAddress.slice(-4)}, до ${exp}`),
      ),
    );
  },

  /**
   * Shown after a successful account login.
   * @param username    In-game username if available.
   * @param agwAddress  AGW address.
   * @param expiresAt   Internal game-session expiry timestamp.
   */
  loginOk(username: string | undefined, agwAddress: string, expiresAt: number): void {
    const exp = new Date(expiresAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const who = username ? `@${username}` : agwAddress.slice(0, 10) + '...';
    out(indent(1, chalk.green(`Вход выполнен`) + dim(` ${who}, сессия до ${exp}`)));
  },

  /**
   * Energy probe result.
   * @param current       Current energy.
   * @param max           Maximum energy.
   * @param energyPerRun  Energy cost per run (40).
   */
  energyProbe(current: number, max: number, energyPerRun: number): void {
    const runs = Math.floor(current / energyPerRun);
    const suffix =
      runs === 0
        ? chalk.red('недостаточно для старта')
        : chalk.dim(`хватит примерно на ${runs} ран(а)`);
    out(indent(1, `Energy: ${chalk.bold(`${current}/${max}`)} — ${suffix}`));
  },

  /**
   * Shown when energy is too low to start even one run.
   * @param current  Current energy.
   * @param needed   Energy needed per run.
   */
  energyInsufficient(current: number, needed: number): void {
    out(indent(1, chalk.red(`Energy ${current}/${needed} — недостаточно, пропускаю аккаунт`)));
  },

  /**
   * Health-check section header — shown once per account before runs start.
   */
  healthCheckBegin(): void {
    out('');
    out(indent(1, chalk.bold('🩺 Проверка готовности аккаунта')));
  },

  /**
   * One line per check inside the health-check block.
   * status drives the leading glyph (✅/⚠️/❌) and colour.
   */
  healthCheckLine(status: 'ok' | 'warn' | 'fail', label: string, detail: string): void {
    const glyph =
      status === 'ok'
        ? chalk.green('✅')
        : status === 'warn'
          ? chalk.yellow('⚠️ ')
          : chalk.red('❌');
    const labelCol = chalk.bold(label.padEnd(16));
    out(indent(2, `${glyph} ${labelCol} ${dim(detail)}`));
  },

  /**
   * Closing line of the health-check block.
   * Caller passes the consolidated ready flag; we colour the outcome line.
   */
  healthCheckEnd(ready: boolean, canRunDungeon = ready): void {
    if (ready) {
      const detail = canRunDungeon
        ? 'Аккаунт готов — сначала кувшины/сундуки, потом раны'
        : 'Аккаунт готов — кувшины/сундуки, данжи по энергии';
      out(indent(2, chalk.green(detail)));
    } else {
      out(indent(2, chalk.red('Аккаунт НЕ готов — пропускаю')));
    }
    out('');
  },

  nodeRewardsBegin(
    paperHands: {
      total: number;
      usable: number;
      repairable: number;
      spent: number;
      samples: string[];
    },
    rockHands: {
      total: number;
      usable: number;
      repairable: number;
      spent: number;
      samples: string[];
    },
  ): void {
    out('');
    out(indent(1, chalk.bold('Кувшины и сундуки')));
    out(indent(2, dim(`Paper Hands: ${formatGloveSummary(paperHands)}`)));
    out(indent(2, dim(`Rock Hands: ${formatGloveSummary(rockHands)}`)));
  },

  nodeRewardRepair(gloveName: string, gearInstanceId: string): void {
    out(indent(2, chalk.yellow(`Ремонт ${gloveName}`) + dim(` ${gearInstanceId}`)));
  },

  nodeRewardCraft(
    label: string,
    rewards: Array<{ itemId: number; amount: number; name?: string }>,
  ): void {
    out(indent(2, chalk.cyan(`Крафт ${label}`) + dim(` · ${formatNodeRewards(rewards)}`)));
  },

  nodeRewardSalvage(gloveName: string, gearInstanceId: string): void {
    out(indent(2, chalk.yellow(`Утилизация ${gloveName}`) + dim(` ${gearInstanceId}`)));
  },

  nodeRewardPot(
    label: string,
    nodeIndex: number,
    rewards: Array<{ itemId: number; amount: number; name?: string }>,
  ): void {
    out(
      indent(
        2,
        chalk.green(`${label} #${nodeIndex}: разбит`) + dim(` · ${formatNodeRewards(rewards)}`),
      ),
    );
  },

  nodeRewardChest(
    label: string,
    rewards: Array<{ itemId: number; amount: number; name?: string }>,
  ): void {
    out(indent(2, chalk.green(`${label}: забран`) + dim(` · ${formatNodeRewards(rewards)}`)));
  },

  nodeRewardSkip(label: string, reason: string): void {
    out(indent(2, chalk.dim(`${label}: пропуск — ${reason}`)));
  },

  nodeRewardNoEnergy(remaining: number): void {
    out(indent(2, chalk.yellow(`Энергия ${remaining}/${5} — кувшины дальше не бью`)));
  },

  nodeRewardsDone(stats: {
    potsBroken: number;
    chestsClaimed: number;
    repairs: number;
    crafted?: number;
    salvaged?: number;
    skipped: number;
  }): void {
    out(
      indent(
        2,
        dim(
          `Итог: кувшинов ${stats.potsBroken}, сундуков ${stats.chestsClaimed}, ремонтов ${stats.repairs}, крафтов ${stats.crafted ?? 0}, утилизаций ${stats.salvaged ?? 0}, пропусков ${stats.skipped}`,
        ),
      ),
    );
    out('');
  },

  dungeonCharmReady(name: string, durability: number): void {
    out(indent(1, chalk.green(`Амулет готов: ${name}`) + dim(` · прочность ${durability}`)));
  },

  dungeonCharmAction(action: string, name: string, detail?: string): void {
    out(indent(1, chalk.cyan(`Амулет · ${action}: ${name}`) + (detail ? dim(` · ${detail}`) : '')));
  },

  dungeonCharmSkip(reason: string): void {
    out(indent(1, dim(`Амулет: ${reason}`)));
  },

  /**
   * Shown when an active stale dungeon run is detected and bot flees it.
   */
  staleFlee(): void {
    out(indent(1, chalk.yellow('Обнаружен активный ран — сбегаю перед стартом...')));
  },

  /**
   * Shown when the bot starts resuming a stale dungeon run instead of
   * abandoning it — keeps the unused-loot warning from the game UI happy.
   */
  resumeBegin(): void {
    out(indent(1, chalk.cyan('▶ Продолжаю незавершённый ран...')));
  },

  /**
   * Shown when start_run failed with a server-revealed actionToken and we're
   * about to drive a recovery resume on top of the hidden stale run.
   */
  startRunRecovery(token: string): void {
    out(
      indent(
        1,
        chalk.yellow(
          `⚠ start_run отверг — найден скрытый активный ран (token ${token.slice(-6)}), пытаюсь продолжить`,
        ),
      ),
    );
  },

  /**
   * Shown when resume failed and we fall back to flee — the next fresh
   * start_run would otherwise be blocked by the stale run on the server.
   */
  resumeFailedFlee(): void {
    out(indent(1, chalk.yellow('Продолжить не удалось — сбегаю чтобы разблокировать аккаунт')));
  },

  /**
   * Shown after successfully fleeing a stale run.
   */
  staleFleeOk(): void {
    out(indent(1, chalk.dim('Убежал от зависшего рана')));
  },

  /**
   * Shown at the start of each dungeon run.
   * @param dungeon    Dungeon ID.
   * @param runNumber  1-based run index for this account.
   */
  runStart(dungeon: 1 | 3, runNumber: number): void {
    out('');
    out(indent(1, chalk.bold(`Ран #${runNumber} · ${dungeonName(dungeon)}`)));
  },

  /**
   * Shown after each combat move (once the response comes back).
   *
   * @param room         Current room number.
   * @param myMove       Move the bot played.
   * @param enemyMove    Move the enemy played (from enemy.lastMove in response).
   * @param myHpBefore   My HP before the move (from prev response).
   * @param myHpAfter    My HP after the move.
   * @param enemyHp      Enemy HP after the move.
   */
  combatStep(
    room: number,
    myMove: string,
    enemyMove: string,
    myHpBefore: number,
    myHpAfter: number,
    enemyHp: number,
  ): void {
    const myDelta = myHpAfter - myHpBefore;
    const myDeltaStr =
      myDelta < 0
        ? chalk.red(`${myDelta} HP`)
        : myDelta > 0
          ? chalk.green(`+${myDelta} HP`)
          : dim('±0');

    const enemyStr = `враг: ${chalk.bold(`${enemyHp} HP`)}`;
    const moveStr = `${chalk.cyan(moveRu(myMove))} vs ${chalk.dim(moveRu(enemyMove))}`;

    out(
      indent(
        2,
        `${roomLabel(room, { capitalize: true })}: ${moveStr} · я: ${myDeltaStr} · ${enemyStr}`,
      ),
    );
  },

  /**
   * Shown when a loot option is picked.
   * @param boon     Boon type string (e.g. "UpgradeRock_ATK").
   * @param room     Room where the loot was offered.
   */
  lootPick(boon: string, room: number): void {
    out(indent(2, chalk.magenta(`Лут (${roomLabel(room)}): `) + chalk.bold(boon)));
  },

  /**
   * Shown when bot dies in the dungeon.
   * @param room  Room where death occurred.
   */
  runDied(room: number): void {
    out(indent(2, chalk.red(`Умер — ${roomLabel(room)}`)));
  },

  /**
   * Shown when a PvP opponent is detected and bot flees.
   * @param room     Room where PvP was detected.
   */
  runFledPvp(room: number): void {
    out(
      indent(2, chalk.yellow(`${roomLabel(room, { capitalize: true })}: PvP противник — сбегаю`)),
    );
  },

  /**
   * Shown when the dungeon run is completed successfully.
   * @param rooms  Number of rooms cleared.
   */
  runComplete(rooms: number): void {
    // `rooms` here is the absolute room index from the server at the moment
    // COMPLETE_CID became true — that's also the highest room the bot reached.
    const { floor, room } = splitRoom(rooms);
    out(
      indent(
        2,
        chalk.green(`Завершён! Дошёл до этажа ${floor} · комната ${room} (всего ${rooms} комнат)`),
      ),
    );
  },

  /**
   * Shown after a run when gear/items were earned (roomInvaderItemsEarned count).
   * @param count  Number of item drops (may be 0).
   */
  runDrops(count: number): void {
    if (count > 0) {
      out(indent(2, dim(`Получено предметов: ${count}`)));
    }
  },

  /**
   * Real-time per-drop announcement — fires every time a NEW gear instance
   * or roomInvaderItem appears in a response. The diff is computed in
   * run-runner so this just prints what's already known new.
   */
  itemDropped(room: number, item: { name: string; rarity?: number; docId?: string }): void {
    const rarityTag = item.rarity !== undefined ? dim(` [rarity=${item.rarity}]`) : '';
    const { floor, room: r } = splitRoom(room);
    out(indent(2, chalk.green(`💎 Дроп (этаж ${floor}·к${r}): ${item.name}${rarityTag}`)));
  },

  /**
   * Shown when energy is checked between runs and is insufficient for another.
   * @param remaining     Current energy.
   * @param energyPerRun  Energy needed per run.
   */
  energyDrained(remaining: number, energyPerRun: number): void {
    out('');
    out(indent(1, chalk.dim(`Energy: ${remaining}/${energyPerRun} — больше не хватает, выхожу`)));
  },

  /**
   * Shown during the inter-run pause.
   * @param ms  Pause duration in milliseconds.
   */
  interRunPause(ms: number): void {
    const sec = Math.round(ms / 1000);
    out(indent(1, dim(`Пауза ${sec}с до следующего рана...`)));
  },

  /**
   * Final per-account summary line.
   * @param name       Account label.
   * @param runs       Total runs attempted.
   * @param deaths     Deaths during runs.
   * @param fled       Fled (PvP) count.
   * @param rooms      Total rooms cleared across all runs.
   * @param durationMs Total elapsed ms for this account.
   */
  accountDone(stats: {
    name: string;
    runs: number;
    deaths: number;
    fled: number;
    rooms: number;
    durationMs: number;
  }): void {
    const sec = Math.round(stats.durationMs / 1000);
    const fled = stats.fled > 0 ? ` · ${chalk.yellow(`${stats.fled} PvP`)}` : '';
    // stats.rooms is the SUM of highest-room-reached across every run.
    // Showing raw number is misleading ("комнат" sounds like fight count),
    // so just show it as "пройдено комнат" with an explanatory note.
    out('');
    out(dim(THIN));
    out(
      chalk.bold(`${stats.name}`) +
        ` · ${stats.runs} ран · ${chalk.red(`${stats.deaths} смертей`)}${fled}` +
        ` · ${stats.rooms} пройдено комнат · ${sec}s`,
    );
    out(dim(THIN));
  },

  /**
   * Shown when an account's run loop dies with an unexpected exception —
   * surfaces the message in the visible log instead of burying it in the
   * JSON pino file where the operator never sees it.
   */
  accountFailed(error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    out('');
    out(indent(1, chalk.red.bold('❌ Аккаунт упал с ошибкой:')));
    // Indent each line of the (possibly multi-line) message so it's clearly nested
    for (const line of msg.split('\n')) {
      out(indent(2, chalk.red(line)));
    }
    // Top stack frames for debugging — dim so they don't shout
    if (error instanceof Error && error.stack) {
      const stackLines = error.stack.split('\n').slice(1, 4);
      for (const line of stackLines) {
        out(indent(2, dim(line.trim())));
      }
    }
    // Also include the raw error body if this is one of our HttpErrors —
    // gigaverse 4xx responses carry the real reason ("dungeon unavailable",
    // "out of energy", "actionToken mismatch", etc.) inside the body field.
    const body = (error as { body?: unknown }).body;
    if (body !== undefined) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      out(indent(2, dim('body: ' + bodyStr.slice(0, 300))));
    }
  },

  /**
   * Shown when all accounts are done.
   */
  allDone(): void {
    out('');
    out(chalk.cyan(LINE));
    out(chalk.bold.cyan('  Все аккаунты обработаны'));
    out(chalk.cyan(LINE));
    out('');
  },
};
