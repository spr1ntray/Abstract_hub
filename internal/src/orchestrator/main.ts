import inquirer from 'inquirer';
import { resolve } from 'path';
import type { Logger } from 'pino';
import { VaultStore } from '../vault/store.js';
import { STATE_DB_PATH, VAULT_PATH } from '../vault/paths.js';
import { requireAccount } from '../vault/accounts.js';
import type { Account } from '../vault/schema.js';
import { GigaClient } from '../api/client.js';
import { resolveAccountSession } from '../api/account-session.js';
import { loadBuildPlan } from '../loot/build-plan.js';
import { runOne, resumeRun, type RunSummary } from './run-runner.js';
import { createLogger } from '../logger.js';
import { NoEnergyError, SessionExpiredError, HttpError } from '../api/errors.js';
import { StateDB } from '../state/db.js';
import { makeSigner, type AgwSigner } from '../wallet/signer.js';
import { resolveMarketplaceSigner } from '../wallet/marketplace-signer.js';
import { diffInventory } from '../marketplace/inventory.js';
import { sellNewItems } from '../marketplace/sell.js';
import type { MarketplaceTransactionSender } from '../marketplace/lister.js';
import type { GearInstance } from '../api/types.js';
import { formatSummary, type RunStats } from './summary.js';
import { runHealthCheck, PreflightError, type HealthCheckResult } from './preflight.js';
import { present } from './presenter.js';
import { humanizeFromRange } from '../timing.js';
import { loadTimingConfig } from '../timing-config.js';
import { runNodeRewards, type NodeRewardEvent } from '../nodes/rewards.js';
import { resolveNoobTokenId } from '../api/noob-id.js';
import {
  createDungeonCharmAutomation,
  type DungeonCharmAutomation,
  type DungeonCharmEvent,
} from '../gear/charm.js';

export { extractNoobTokenId } from '../api/noob-id.js';

// Load timing config once at module init — picks up ~/.gigabot/timing.json or env overrides.
const tcfg = loadTimingConfig();

export interface MainArgs {
  account?: string;
  all: boolean;
  /** Default dungeon when the account has no per-account `dungeon` override. */
  dungeon: 1 | 3;
  dryRun: boolean;
  list: boolean;
}

export async function main(args: MainArgs): Promise<void> {
  const log = createLogger();

  const { password } = await inquirer.prompt<{ password: string }>([
    { type: 'password', name: 'password', mask: '*', message: 'Master password:' },
  ]);

  const store = new VaultStore(VAULT_PATH);
  const vault = await store.load(password);
  log.info({ accounts: vault.accounts.length }, 'vault unlocked');

  const targets: Account[] = args.all ? vault.accounts : [requireAccount(vault, args.account!)];

  if (targets.length === 0) {
    log.error('no accounts in vault — run `pnpm vault add-account`');
    process.exit(1);
  }

  for (const acc of targets) {
    log.info({ account: acc.name }, '=== begin account ===');
    try {
      await runForAccount(acc, args, log);
    } catch (e) {
      if (e instanceof PreflightError) {
        // Print the actionable multi-line message directly — no log framing.
        console.error('\n' + e.message + '\n');
      } else {
        log.error({ account: acc.name, err: e }, 'account run failed');
      }
      // in --all mode, keep going so other accounts still get their runs
      if (!args.all) throw e;
    }
    log.info({ account: acc.name }, '=== end account ===');
  }
}

export async function runForAccount(account: Account, args: MainArgs, log: Logger): Promise<void> {
  // Abstract accounts use a browser-approved delegated signer. Private-key
  // accounts remain supported for existing configurations.
  let agw: AgwSigner | undefined;
  let marketplaceSigner: MarketplaceTransactionSender | undefined;
  let agwAddress: string;

  if (account.privateKey) {
    agw = await makeSigner(account);
    marketplaceSigner = agw;
    agwAddress = account.agwAddress ?? agw.account.address;
    if (agw.account.address.toLowerCase() !== agwAddress.toLowerCase()) {
      throw new Error(
        `Gigamarket signer for "${account.name}" resolves to ${agw.account.address}, expected ${agwAddress}`,
      );
    }
  } else if (account.agwAddress) {
    agwAddress = account.agwAddress;
  } else {
    throw new Error(`Для аккаунта "${account.name}" не настроен вход через Abstract`);
  }

  // Show account header in the human-readable output now that we have the address.
  present.accountStart(account.name, agwAddress);

  // Per-account dungeon override, falling back to CLI default.
  const effectiveDungeon: 1 | 3 = account.dungeon ?? args.dungeon;

  if (args.dryRun) {
    log.info(
      {
        account: account.name,
        agw: agwAddress,
        mode: account.privateKey ? 'private-key' : 'abstract-browser',
        dungeon: effectiveDungeon,
        dungeonSource: account.dungeon ? 'per-account' : 'default',
        list: args.list,
      },
      'dry-run: no actions will be sent',
    );
    return;
  }

  // Resolve a short-lived game session. Abstract accounts sign the login
  // automatically through the browser-approved local delegation.
  const resolvedSession = await resolveAccountSession({
    account,
    log,
    ...(agw ? { makeEoaSigner: async () => agw! } : {}),
  });
  const loginRes = resolvedSession.loginResult;
  const { jwt, expiresAt, gameAccount } = loginRes;
  const username =
    typeof loginRes.gameAccount.username === 'string' ? loginRes.gameAccount.username : undefined;
  log.info(
    {
      account: account.name,
      agw: agwAddress,
      expiresAt,
      mode: resolvedSession.mode,
    },
    'Gigaverse session ready',
  );
  present.loginOk(username, agwAddress, expiresAt);
  const client = new GigaClient(account, log);
  client.setJwt(jwt);

  let noobIdForNodes = await resolveNoobTokenId(client, agwAddress, gameAccount, log);
  const gameAccountForHealth =
    noobIdForNodes !== undefined
      ? withResolvedNoobTokenId(gameAccount, noobIdForNodes)
      : gameAccount;

  let db: StateDB | undefined;
  if (args.list) {
    if (!marketplaceSigner) {
      try {
        const resolved = await resolveMarketplaceSigner(account);
        marketplaceSigner = resolved.signer;
      } catch (error) {
        log.warn(
          { account: account.name, err: error },
          '--list requested but Abstract is not connected for marketplace transactions.',
        );
      }
    }
    if (!marketplaceSigner) {
      log.warn(
        { account: account.name },
        '--list requested but the account has no marketplace signer. Skipping listing.',
      );
    } else {
      db = new StateDB(STATE_DB_PATH);
      log.info({ agw: agwAddress }, 'signer ready');
    }
  }
  // Single-exit guarantee for the StateDB handle across every return path
  // below (energy-insufficient, stale-flee failure, NoEnergyError, etc).
  const closeDb = (): void => {
    if (db) {
      try {
        db.close();
      } catch {
        /* best-effort */
      }
      db = undefined;
    }
  };

  const plan = loadBuildPlan(process.env['GIGABOT_BUILD_PLAN'] ?? resolve('internal/build.yaml'));

  // Energy cost per run (40, from /api/offchain/static — see research notes)
  const ENERGY_PER_RUN = 40;

  // ── Health-check phase ──
  // Single structured pre-flight pass:
  //   • account readiness (canEnterGame, noob NFT, game-session expiry)
  //   • energy (warns when it cannot cover a run; node rewards may still work)
  //   • active run — if found, salvage any pending loot then abandon
  //   • dungeon availability today
  // The result drives the presenter so the operator sees a clear status board
  // per account before any run starts.
  present.healthCheckBegin();
  let healthResult: HealthCheckResult;
  try {
    healthResult = await runHealthCheck({
      client,
      agwAddress,
      dungeonId: effectiveDungeon,
      gameAccount: gameAccountForHealth,
      expiresAt,
      accountName: account.name,
      log,
    });
  } catch (e) {
    present.healthCheckLine('fail', 'Проверка', e instanceof Error ? e.message : String(e));
    present.healthCheckEnd(false);
    closeDb();
    return;
  }
  for (const step of healthResult.steps) {
    present.healthCheckLine(step.status, step.label, step.detail);
  }
  present.healthCheckEnd(healthResult.ready, healthResult.canRunDungeon);

  if (!healthResult.ready) {
    log.warn(
      { account: account.name, steps: healthResult.steps },
      'health check failed — skipping account',
    );
    closeDb();
    return;
  }

  const start = Date.now();
  const allPicks: string[] = [];
  let deaths = 0;
  let fled = 0;
  let totalRooms = 0;
  let runs = 0;
  let baseline: GearInstance[] | undefined;
  let latest: GearInstance[] = [];
  let sellSummary = { considered: 0, listed: 0, skipped: 0, failed: 0 };
  let charmAutomation: DungeonCharmAutomation | undefined;

  try {
    const noobId =
      noobIdForNodes ?? (await resolveNoobTokenId(client, agwAddress, gameAccount, log));
    noobIdForNodes = noobId;
    if (noobId === undefined) {
      log.warn({ account: account.name }, 'node rewards skipped: missing noob id');
      present.nodeRewardSkip('Кувшины и сундуки', 'не нашёл noobId');
    } else {
      await runNodeRewards({
        client,
        agwAddress,
        noobId,
        log,
        onEvent: presentNodeRewardEvent,
      });
      try {
        charmAutomation = await createDungeonCharmAutomation({
          client,
          agwAddress,
          noobId,
          log,
          onEvent: presentDungeonCharmEvent,
        });
      } catch (error) {
        log.warn({ err: error }, 'dungeon charm automation unavailable');
        present.dungeonCharmSkip(
          `автоматизация амулетов недоступна: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // If the health-check found a stale run, finish it first via resumeRun
    // instead of abandoning. The dungeon's loot — UpgradeRock_ATK, armor,
    // HP boons earned in earlier rooms — only credits when we COMPLETE or
    // DIE in the run, not when we flee mid-flight. So we play it out.
    if (healthResult.staleRun) {
      present.resumeBegin();
      try {
        const summary: RunSummary = await resumeRun(
          client,
          effectiveDungeon,
          plan,
          log,
          healthResult.staleRun,
        );
        runs++;
        log.info({ account: account.name, run: runs, resumed: true, ...summary }, 'run done');
        if (baseline === undefined) baseline = summary.initialInventory;
        latest = summary.finalInventory;
        allPicks.push(...summary.picks);
        if (summary.died) deaths++;
        if (summary.fled) fled++;
        totalRooms += summary.rooms;
      } catch (e) {
        // Resume failed — flee so future start_run isn't blocked by the stale
        // run; then continue with normal fresh runs.
        log.warn({ account: account.name, err: e }, 'resume failed — fleeing to unblock');
        present.resumeFailedFlee();
        try {
          const token = extractActionTokenFromError(e);
          if (token) client.setLastActionToken(token);
          await client.flee();
        } catch (fleeErr) {
          log.error(
            { account: account.name, err: fleeErr },
            'flee after failed resume also failed',
          );
          closeDb();
          return;
        }
      }
    }

    let canStartFreshRuns = !hasFreshDungeonPreflightBlock(healthResult);
    try {
      const energy = await client.getEnergy(agwAddress);
      if (energy.energyValue < ENERGY_PER_RUN) {
        canStartFreshRuns = false;
        log.info({ energy: energy.energyValue, runs }, 'energy below dungeon cost after nodes');
        present.energyDrained(energy.energyValue, ENERGY_PER_RUN);
      }
    } catch (e) {
      canStartFreshRuns = false;
      log.warn({ err: e }, 'could not re-check energy after node rewards');
    }

    if (!canStartFreshRuns) {
      log.info({ account: account.name, runs }, 'fresh dungeon loop skipped after node rewards');
    }

    while (canStartFreshRuns) {
      if (charmAutomation) {
        try {
          await charmAutomation.prepareForRun();
        } catch (error) {
          log.warn({ err: error }, 'dungeon charm preparation failed; continuing without it');
          present.dungeonCharmSkip(
            `подготовка амулета не выполнена: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      try {
        const energyBeforeRun = await client.getEnergy(agwAddress);
        if (energyBeforeRun.energyValue < ENERGY_PER_RUN) {
          canStartFreshRuns = false;
          present.energyDrained(energyBeforeRun.energyValue, ENERGY_PER_RUN);
          break;
        }
      } catch (error) {
        canStartFreshRuns = false;
        log.warn({ err: error }, 'could not check energy after charm preparation');
        break;
      }

      present.runStart(effectiveDungeon, runs + 1);
      let summary: RunSummary;
      try {
        summary = await runOne(client, effectiveDungeon, plan, log);
      } catch (e) {
        // gigaverse sometimes hides an active run from /dungeon/state but
        // reveals it when start_run fails: the response body includes the
        // canonical actionToken. Use it to resume + continue, instead of
        // letting the operator's whole loop die.
        const recovery = tryRecoverFromStartRunError(e);
        if (recovery) {
          log.warn(
            { account: account.name, recoveredToken: recovery.actionToken },
            'start_run failed — recovering from server-supplied actionToken',
          );
          present.startRunRecovery(recovery.actionToken);
          try {
            summary = await resumeRun(client, effectiveDungeon, plan, log, {
              actionToken: recovery.actionToken,
              run: { ROOM_NUM_CID: 1 },
            });
          } catch (resumeErr) {
            // Resume also failed — flee to unblock and skip THIS attempt
            // (the next iteration will try a fresh start_run).
            log.warn(
              { account: account.name, err: resumeErr },
              'recovery resume failed — fleeing and retrying',
            );
            try {
              const token = extractActionTokenFromError(resumeErr) ?? recovery.actionToken;
              client.setLastActionToken(token);
              await client.flee();
            } catch (fleeErr) {
              log.error({ account: account.name, err: fleeErr }, 'flee after recovery also failed');
              canStartFreshRuns = false;
              break;
            }
            continue;
          }
        } else if (tryRecoverFromDungeonActionError(e)) {
          const token = extractActionTokenFromError(e);
          if (!token) throw e;
          log.warn(
            { account: account.name, recoveredToken: token, err: e },
            'dungeon action failed with server token — fleeing and retrying',
          );
          try {
            client.setLastActionToken(token);
            await client.flee();
          } catch (fleeErr) {
            log.error({ account: account.name, err: fleeErr }, 'flee after action error failed');
            canStartFreshRuns = false;
            break;
          }
          continue;
        } else {
          throw e;
        }
      }
      runs++;
      log.info({ account: account.name, run: runs, ...summary }, 'run done');

      if (baseline === undefined) baseline = summary.initialInventory;
      latest = summary.finalInventory;

      allPicks.push(...summary.picks);
      if (summary.died) deaths++;
      if (summary.fled) fled++;
      totalRooms += summary.rooms;

      if (charmAutomation) {
        try {
          await charmAutomation.cleanupAfterRun();
        } catch (error) {
          log.warn({ err: error }, 'finished dungeon charm cleanup failed');
        }
      }

      // Cheap probe — bail early instead of waiting for NoEnergyError
      const energy = await client.getEnergy(agwAddress);
      if (energy.energyValue < ENERGY_PER_RUN) {
        log.info({ energy: energy.energyValue, runs }, 'energy drained — done');
        present.energyDrained(energy.energyValue, ENERGY_PER_RUN);
        break;
      }

      // Human-realistic inter-run break from user config (~60-240s by default).
      // GIGABOT_FAST=true halves the range for development testing.
      const rangeToUse =
        process.env.GIGABOT_FAST === 'true'
          ? {
              minMs: Math.floor(tcfg.interRun.minMs / 2),
              maxMs: Math.floor(tcfg.interRun.maxMs / 2),
            }
          : tcfg.interRun;
      const interRun = humanizeFromRange(rangeToUse);
      log.info({ ms: interRun, sec: Math.round(interRun / 1000) }, 'inter-run pause');
      present.interRunPause(interRun);
      await sleep(interRun);
    }
  } catch (e) {
    if (e instanceof NoEnergyError) {
      log.info({ account: account.name, runs }, 'energy drained — moving on');
    } else if (e instanceof SessionExpiredError) {
      // The game session expired mid-run — caller will propagate so the account can be
      // retried on the next scheduled cycle with a fresh login.
      log.error({ account: account.name, runs }, 'game session expired mid-run');
      closeDb();
      return;
    } else {
      closeDb();
      throw e;
    }
  }

  // Sell phase — opt-in via --list and requires an AGW signer.
  // try/finally guarantees the StateDB handle is closed even if sellNewItems throws.
  if (args.list && db && marketplaceSigner && baseline !== undefined) {
    try {
      const newItems = diffInventory(baseline, latest);
      log.info({ count: newItems.length }, 'sell phase: new items found');
      if (newItems.length > 0) {
        sellSummary = await sellNewItems({
          giga: client,
          agw: marketplaceSigner,
          db,
          sellerAddress: agwAddress,
          newItems,
          log,
        });
      }
    } finally {
      closeDb();
    }
  } else {
    closeDb();
  }

  log.info({ account: account.name, runs }, 'done');

  const durationMs = Date.now() - start;
  const stats: RunStats = {
    runs,
    deaths,
    fled,
    rooms: totalRooms,
    picks: allPicks,
    considered: sellSummary.considered,
    listed: sellSummary.listed,
    skipped: sellSummary.skipped,
    failed: sellSummary.failed,
    durationMs,
  };
  present.accountDone({ name: account.name, runs, deaths, fled, rooms: totalRooms, durationMs });
  console.warn(`\n=== ${account.name} ===\n` + formatSummary(stats));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withResolvedNoobTokenId<T extends Record<string, unknown>>(
  gameAccount: T,
  noobId: number,
): T {
  const noob = gameAccount['noob'];
  const noobObj = noob && typeof noob === 'object' ? (noob as Record<string, unknown>) : {};
  return { ...gameAccount, noob: { ...noobObj, _id: String(noobId) } } as T;
}

function presentNodeRewardEvent(event: NodeRewardEvent): void {
  switch (event.type) {
    case 'begin':
      present.nodeRewardsBegin(event.paperHands, event.rockHands);
      break;
    case 'repair':
      present.nodeRewardRepair(event.gloveName, event.gearInstanceId);
      break;
    case 'craft':
      present.nodeRewardCraft(event.label, event.rewards);
      break;
    case 'salvage':
      present.nodeRewardSalvage(event.gloveName, event.gearInstanceId);
      break;
    case 'pot':
      present.nodeRewardPot(event.label, event.nodeIndex, event.rewards);
      break;
    case 'chest':
      present.nodeRewardChest(event.label, event.rewards);
      break;
    case 'skip':
      present.nodeRewardSkip(event.label, event.reason);
      break;
    case 'no-energy':
      present.nodeRewardNoEnergy(event.remaining);
      break;
    case 'done':
      present.nodeRewardsDone(event.summary);
      break;
  }
}

function presentDungeonCharmEvent(event: DungeonCharmEvent): void {
  switch (event.type) {
    case 'ready':
      present.dungeonCharmReady(event.name, event.durability);
      break;
    case 'equipped':
      present.dungeonCharmAction('Надет', event.name, `прочность ${event.durability}`);
      break;
    case 'repaired':
      present.dungeonCharmAction(
        'Починен',
        event.name,
        `прочность ${event.durability}, ремонт ${event.repairCount}`,
      );
      break;
    case 'crafted':
      present.dungeonCharmAction('Скрафчен', event.name, event.recipeId);
      break;
    case 'salvaged':
      present.dungeonCharmAction('Утилизирован', event.name);
      break;
    case 'skipped':
      present.dungeonCharmSkip(event.reason);
      break;
  }
}

function hasFreshDungeonPreflightBlock(healthResult: HealthCheckResult): boolean {
  return healthResult.steps.some((step) => step.label === 'Данж сегодня' && step.status === 'fail');
}

function tryRecoverFromDungeonActionError(e: unknown): boolean {
  if (!(e instanceof HttpError)) return false;
  const body = normalizeHttpErrorBody(e);
  if (!body) return false;
  if (extractActionTokenFromBody(body) === undefined) return false;
  const msg = `${String(body['message'] ?? '')} ${String(body['error'] ?? '')}`;
  return /error handling dungeon action/i.test(msg) || /error handling move/i.test(msg);
}

/**
 * If `e` is an HttpError whose body carries `{message: "Error starting dungeon",
 * actionToken}` (server-revealed stale run), return the actionToken as a string.
 * Otherwise return null.
 */
function tryRecoverFromStartRunError(e: unknown): { actionToken: string } | null {
  if (!(e instanceof HttpError)) return null;
  const body = normalizeHttpErrorBody(e);
  if (!body) return null;
  const msg = body.message;
  // Match the exact gigaverse error string AND any close variant ("error
  // starting", "already in dungeon", etc.) so future wording tweaks don't
  // break recovery.
  const looksLikeStaleStart =
    typeof msg === 'string' &&
    (/error starting/i.test(msg) || /already in dungeon/i.test(msg) || /active run/i.test(msg));
  if (!looksLikeStaleStart) return null;
  const token = extractActionTokenFromBody(body);
  if (token) return { actionToken: token };
  return null;
}

function extractActionTokenFromError(e: unknown): string | undefined {
  if (!(e instanceof HttpError)) return undefined;
  const body = normalizeHttpErrorBody(e);
  return body ? extractActionTokenFromBody(body) : undefined;
}

function extractActionTokenFromBody(body: Record<string, unknown>): string | undefined {
  const token = body['actionToken'];
  if (typeof token === 'number') return String(token);
  if (typeof token === 'string' && token.length > 0) return token;
  return undefined;
}

function normalizeHttpErrorBody(e: HttpError): Record<string, unknown> | undefined {
  const body = e.body;
  if (body && typeof body === 'object') return body as Record<string, unknown>;
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
