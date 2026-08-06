/**
 * Skill upgrade loop — calls the Gigaverse API to spend skill points on the
 * user's chosen build until no more upgrades are possible or the server
 * rejects a request (out of points, etc).
 */

import type { Logger } from 'pino';
import type { GigaClient } from '../api/client.js';
import { HttpError } from '../api/errors.js';
import { humanizeFromRange } from '../timing.js';
import { parseSkillCatalog, parseSkillProgress } from './parse.js';
import { pickNextUpgrade, applyUpgradeLocally, STAT_NAMES_RU } from './strategy.js';
import type { PickOptions } from './strategy.js';
import type { SkillProgressMap, UpgradeCandidate } from './types.js';

export interface UpgradeLoopOptions {
  /** Stop after this many successful upgrades. Useful for "burn 10 points at a time" UI. */
  maxUpgrades?: number;
  /**
   * Re-fetch progress from the server every N successful upgrades to reconcile
   * any drift caused by other clients (e.g. the user upgrading in-browser at
   * the same time). Set to 0 to never reconcile until the loop finishes.
   */
  reconcileEvery?: number;
  /** Pause between upgrades in ms. Random in this range each iteration. */
  delayRangeMs?: { minMs: number; maxMs: number };
  /** Stop cleanly after this many milliseconds, checked between API calls. */
  timeLimitMs?: number;
  /** Restriction on which stats/skills to touch (defaults to sword+armor+crystal). */
  pick?: PickOptions;
}

export interface UpgradeLoopResult {
  upgraded: UpgradeCandidate[];
  /** Reason the loop stopped — "out of points" / "max reached" / "rate limited" / "max upgrades". */
  stopReason: string;
  finalProgress: SkillProgressMap;
}

/**
 * Drive the skill-upgrade loop for one character (noobId).
 *
 * Strategy:
 *   1. Fetch catalog + current progress.
 *   2. Pick the cheapest allowed stat → POST /levelup.
 *   3. Update local progress copy (server returns PRE-state, not POST-state).
 *   4. Pause humanish ms, then go to 2.
 *   5. Every N upgrades, re-GET progress to reconcile.
 *   6. Stop on: maxUpgrades reached, no candidate, or HttpError.
 */
export async function runSkillUpgradeLoop(
  client: GigaClient,
  noobId: number,
  log: Logger,
  opts: UpgradeLoopOptions = {},
): Promise<UpgradeLoopResult> {
  const reconcileEvery = opts.reconcileEvery ?? 5;
  const maxUpgrades = opts.maxUpgrades ?? Number.MAX_SAFE_INTEGER;
  const delayRange = opts.delayRangeMs ?? { minMs: 300, maxMs: 800 };
  const timeLimitMs = opts.timeLimitMs && opts.timeLimitMs > 0 ? opts.timeLimitMs : undefined;
  const deadline = timeLimitMs === undefined ? undefined : Date.now() + timeLimitMs;

  const catalogRaw = await client.getSkillsCatalog();
  const catalog = parseSkillCatalog(catalogRaw);
  log.info({ skills: catalog.size }, 'skills catalog loaded');

  let progressRaw = await client.getSkillsProgress(noobId);
  let progress = parseSkillProgress(progressRaw);
  log.info({ skills: progress.size }, 'progress fetched');

  const upgraded: UpgradeCandidate[] = [];
  let stopReason = 'no more candidates';

  while (upgraded.length < maxUpgrades) {
    if (deadline !== undefined && Date.now() >= deadline) {
      stopReason = `time limit reached (${Math.ceil(timeLimitMs! / 1_000)}s)`;
      break;
    }

    const candidate = pickNextUpgrade(catalog, progress, opts.pick);
    if (!candidate) {
      stopReason = 'no more allowed stats can be upgraded';
      break;
    }

    log.info(
      {
        skillId: candidate.skillId,
        stat: STAT_NAMES_RU[candidate.statId],
        fromLevel: candidate.fromLevel,
        cost: candidate.cost,
      },
      'levelup attempt',
    );

    try {
      await client.levelUpSkill({
        skillId: candidate.skillId,
        statId: candidate.statId,
        noobId,
      });
    } catch (e) {
      if (e instanceof HttpError) {
        const body = e.body as { message?: string; error?: string } | undefined;
        const msg = body?.message ?? body?.error ?? `HTTP ${e.status}`;
        log.warn({ candidate, status: e.status, msg }, 'levelup rejected — stopping');
        stopReason = msg;
        break;
      }
      throw e;
    }

    upgraded.push(candidate);
    progress = applyUpgradeLocally(progress, candidate);

    // Periodic reconciliation against the server — guards against drift if
    // the user clicks in the browser while the bot is also upgrading.
    if (reconcileEvery > 0 && upgraded.length % reconcileEvery === 0) {
      try {
        progressRaw = await client.getSkillsProgress(noobId);
        progress = parseSkillProgress(progressRaw);
        log.info({ at: upgraded.length }, 'progress reconciled');
      } catch (e) {
        // Reconciliation failure is non-fatal — we keep the local copy.
        log.warn({ err: e }, 'progress reconcile failed; continuing with local copy');
      }
    }

    const delay = humanizeFromRange(delayRange);
    const remaining = deadline === undefined ? delay : Math.max(0, deadline - Date.now());
    await sleep(Math.min(delay, remaining));
  }

  if (upgraded.length >= maxUpgrades) stopReason = `max upgrades reached (${maxUpgrades})`;

  log.info({ upgraded: upgraded.length, stopReason }, 'skill upgrade loop done');
  return { upgraded, stopReason, finalProgress: progress };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
