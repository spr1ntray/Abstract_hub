/**
 * Skill-upgrade strategy.
 *
 * User's chosen build (2026-05-30 spec):
 *   • Меч     = SwordATK + SwordDEF   (stats 0, 1)
 *   • Броня   = ShieldATK + ShieldDEF (stats 2, 3)
 *   • Кристалл = SpellATK + SpellDEF  (stats 4, 5)
 *
 * Max HP (6) and Max AMR (7) are deliberately ignored — those are catch-up
 * stats and the user prefers the offensive/defensive trio.
 *
 * Picking the next upgrade:
 *   1. Within the allowed-stat set, filter out stats already at max.
 *   2. Pick the cheapest one (minimum levelsPerPoint[currentLevel]). This
 *      maximizes total upgrades per skill-point pool and keeps stat levels
 *      balanced — a stat at level 9 (1pt) will be picked over a stat at
 *      level 10 (2pt) until they level-match.
 *   3. Ties are broken by the user-specified priority order (sword > armor
 *      > crystal) so a balanced budget tilts toward sword.
 */

import type {
  SkillCatalog,
  SkillProgress,
  SkillProgressMap,
  StatId,
  SkillId,
  UpgradeCandidate,
  SkillStatCatalog,
} from './types.js';
import { nextUpgradeCost, currentStatLevel, maxStatLevel } from './parse.js';

/** User-configured allowed stats (sword + armor + crystal, each ATK+DEF). */
export const DEFAULT_ALLOWED_STATS: StatId[] = [0, 1, 2, 3, 4, 5];

/** Combat skill trees. Fishing and Temporal Void use different stat meanings. */
export const DEFAULT_ALLOWED_SKILLS: SkillId[] = [1, 2];

/** Priority within the allowed set — lower index wins ties. */
const PRIORITY_ORDER: StatId[] = [0, 1, 2, 3, 4, 5];

export interface PickOptions {
  /** Subset of stat IDs the bot is allowed to touch. Default: sword/armor/crystal. */
  allowedStats?: StatId[];
  /** Subset of skill IDs to consider. Default: Dungetron 5000 + Underhaul. */
  allowedSkills?: SkillId[];
}

/**
 * Pick the next upgrade across all skills the character has progress in.
 *
 * Returns `null` when nothing can be upgraded (every allowed stat is maxed
 * or absent from the catalog).
 */
export function pickNextUpgrade(
  catalog: SkillCatalog,
  progress: SkillProgressMap,
  opts: PickOptions = {},
): UpgradeCandidate | null {
  const allowedStats = new Set(opts.allowedStats ?? DEFAULT_ALLOWED_STATS);
  const allowedSkills = new Set(opts.allowedSkills ?? DEFAULT_ALLOWED_SKILLS);

  let best: UpgradeCandidate | null = null;
  let bestPriority = Number.MAX_SAFE_INTEGER;

  for (const [skillId, prog] of progress) {
    if (!allowedSkills.has(skillId)) continue;
    const entry = catalog.get(skillId);
    if (!entry) continue;

    for (const stat of entry.stats) {
      if (!allowedStats.has(stat.id)) continue;
      const candidate = candidateFor(skillId, stat, prog);
      if (!candidate) continue;
      const priority = PRIORITY_ORDER.indexOf(stat.id);
      if (
        !best ||
        candidate.cost < best.cost ||
        (candidate.cost === best.cost && priority < bestPriority)
      ) {
        best = candidate;
        bestPriority = priority;
      }
    }
  }

  return best;
}

function candidateFor(
  skillId: SkillId,
  stat: SkillStatCatalog,
  progress: SkillProgress,
): UpgradeCandidate | null {
  const level = currentStatLevel(progress, stat.id);
  if (level >= maxStatLevel(stat)) return null;
  const cost = nextUpgradeCost(stat, level);
  if (!Number.isFinite(cost)) return null;
  return { skillId, statId: stat.id, fromLevel: level, cost };
}

/**
 * Apply an upgrade to a progress map locally, without re-fetching the server.
 *
 * Returns a NEW SkillProgressMap with the stat incremented; the input is
 * left untouched (so callers can keep an immutable record around).
 *
 * Why we need this: gigaverse's /levelup response returns the PRE-mutation
 * state, so we have to track the new level ourselves between calls. The
 * caller will periodically re-GET progress to reconcile drift.
 */
export function applyUpgradeLocally(
  progress: SkillProgressMap,
  candidate: UpgradeCandidate,
): SkillProgressMap {
  const next = new Map(progress);
  const cur = next.get(candidate.skillId);
  if (!cur) return next;
  const levels = cur.levels.slice();
  while (levels.length <= candidate.statId) levels.push(null);
  levels[candidate.statId] = candidate.fromLevel + 1;
  next.set(candidate.skillId, { ...cur, levels });
  return next;
}

/** Human-readable stat name, kept central so logs and UI stay in sync. */
export const STAT_NAMES_RU: Record<StatId, string> = {
  0: 'Меч (атака)',
  1: 'Меч (защита)',
  2: 'Броня (атака)',
  3: 'Броня (защита)',
  4: 'Кристалл (атака)',
  5: 'Кристалл (защита)',
  6: 'HP',
  7: 'Броня (макс.)',
};
