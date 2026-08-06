/**
 * Parsers for the raw gigaverse skill responses.
 *
 * Kept pure (no HTTP) so unit tests can exercise them with fixture data
 * captured from HAR.
 */

import type {
  SkillCatalog,
  SkillCatalogEntry,
  SkillProgress,
  SkillProgressMap,
  SkillStatCatalog,
  SkillId,
  StatId,
} from './types.js';

/** Pull the inner array from a possibly-wrapped response. */
function unwrap(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  for (const key of ['entities', 'items', 'data', 'result']) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  return [];
}

function isSkillId(n: unknown): n is SkillId {
  return n === 1 || n === 2 || n === 3 || n === 4;
}

function asStatId(n: unknown): StatId | undefined {
  if (typeof n !== 'number') return undefined;
  if (n >= 0 && n <= 7) return n as StatId;
  return undefined;
}

/** Parse GET /api/offchain/skills into a Map<SkillId, SkillCatalogEntry>. */
export function parseSkillCatalog(raw: unknown): SkillCatalog {
  const map: SkillCatalog = new Map();
  for (const entry of unwrap(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const docIdRaw = o['docId'];
    const docId = typeof docIdRaw === 'string' ? docIdRaw : String(docIdRaw ?? '');
    const numericId = Number(docId);
    if (!isSkillId(numericId)) continue;

    const statsRaw = Array.isArray(o['stats']) ? (o['stats'] as unknown[]) : [];
    const stats: SkillStatCatalog[] = [];
    for (const s of statsRaw) {
      if (!s || typeof s !== 'object') continue;
      const so = s as Record<string, unknown>;
      const id = asStatId(so['id']);
      if (id === undefined) continue;
      const lpp = Array.isArray(so['levelsPerPoint'])
        ? (so['levelsPerPoint'] as unknown[]).filter(
            (n): n is number => typeof n === 'number' && Number.isFinite(n),
          )
        : [];
      const stat: SkillStatCatalog = {
        id,
        name: typeof so['name'] === 'string' ? (so['name'] as string) : `stat#${id}`,
        levelsPerPoint: lpp,
      };
      if (typeof so['increaseKey'] === 'string') stat.increaseKey = so['increaseKey'] as string;
      if (typeof so['increaseIndex'] === 'number')
        stat.increaseIndex = so['increaseIndex'] as number;
      if (typeof so['increaseValue'] === 'number')
        stat.increaseValue = so['increaseValue'] as number;
      if (typeof so['unit'] === 'string') stat.unit = so['unit'] as string;
      stats.push(stat);
    }

    const ce: SkillCatalogEntry = {
      docId,
      name: typeof o['name'] === 'string' ? (o['name'] as string) : `skill#${numericId}`,
      stats,
    };
    if (typeof o['GAME_ITEM_ID_CID'] === 'number')
      ce.GAME_ITEM_ID_CID = o['GAME_ITEM_ID_CID'] as number;
    if (typeof o['LEVEL_CID'] === 'number') ce.LEVEL_CID = o['LEVEL_CID'] as number;
    map.set(numericId, ce);
  }
  return map;
}

/** Parse GET /api/offchain/skills/progress/{noobId} into a Map<SkillId, SkillProgress>. */
export function parseSkillProgress(raw: unknown): SkillProgressMap {
  const map: SkillProgressMap = new Map();
  for (const entry of unwrap(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const skillRaw = o['SKILL_CID'];
    if (!isSkillId(skillRaw)) continue;
    const noob = typeof o['NOOB_TOKEN_CID'] === 'number' ? (o['NOOB_TOKEN_CID'] as number) : 0;
    const arr = Array.isArray(o['LEVEL_CID_array'])
      ? (o['LEVEL_CID_array'] as unknown[]).map((v) => (typeof v === 'number' ? v : null))
      : [];
    const prog: SkillProgress = {
      SKILL_CID: skillRaw,
      NOOB_TOKEN_CID: noob,
      levels: arr,
    };
    map.set(skillRaw, prog);
  }
  return map;
}

/**
 * Get the cost to bump a stat from its current level by +1.
 * Returns Infinity when the stat is already at max level.
 */
export function nextUpgradeCost(stat: SkillStatCatalog, currentLevel: number): number {
  const lpp = stat.levelsPerPoint;
  if (currentLevel < 0 || currentLevel >= lpp.length) return Infinity;
  return lpp[currentLevel] ?? Infinity;
}

/** Current level of a stat in a progress record. Null/missing → 0. */
export function currentStatLevel(progress: SkillProgress, statId: StatId): number {
  const v = progress.levels[statId];
  return typeof v === 'number' ? v : 0;
}

/** Max level — derived from levelsPerPoint length (25 in the live API). */
export function maxStatLevel(stat: SkillStatCatalog): number {
  return stat.levelsPerPoint.length;
}
