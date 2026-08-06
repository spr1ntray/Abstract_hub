/**
 * Types for the Gigaverse skill-upgrade system.
 *
 * Sources observed in HAR:
 *   GET /api/offchain/skills                  → SkillCatalogResponse
 *   GET /api/offchain/skills/progress/{noobId} → SkillProgressResponse
 *   POST /api/game/skill/levelup              → SkillLevelupResponse
 *
 * Combat stat IDs (skills 1 and 2 only):
 *   0 Sword ATK   1 Sword DEF
 *   2 Shield ATK  3 Shield DEF
 *   4 Spell ATK   5 Spell DEF
 *   6 Max HP      7 Max AMR
 *
 * Fishing and Temporal Void reuse numeric IDs for unrelated stats, so the
 * combat strategy must never include skills 3 or 4.
 *
 * The skill upgrade level rises by 1 per call to /levelup. Cost in skill
 * points is `stats[statId].levelsPerPoint[currentLevel]`. Levels 1-9 cost 1,
 * 10-16 cost 2, 17-22 cost 3, 23-25 cost 4. Max stat level is 25.
 */

export type StatId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Skill ids actually playable: 1=Dungeon5000, 2=Underhaul, 3=Fishing, 4=Temporal Void. */
export type SkillId = 1 | 2 | 3 | 4;

/** Static stat descriptor inside a SkillCatalog row. */
export interface SkillStatCatalog {
  id: StatId;
  name: string;
  /** Cost in skill points to raise this stat from level k to k+1. Length 25. */
  levelsPerPoint: number[];
  increaseKey?: string;
  increaseIndex?: number;
  increaseValue?: number;
  unit?: string;
}

/** Static catalog row — one per playable skill. */
export interface SkillCatalogEntry {
  docId: string;
  name: string;
  GAME_ITEM_ID_CID?: number;
  LEVEL_CID?: number;
  stats: SkillStatCatalog[];
}

/** Map<SkillId, SkillCatalogEntry> for fast lookups. */
export type SkillCatalog = Map<SkillId, SkillCatalogEntry>;

/** Per-character progress for a single skill. */
export interface SkillProgress {
  SKILL_CID: SkillId;
  NOOB_TOKEN_CID: number;
  /**
   * Current level per stat. `levels[statId] ?? 0`. Missing index or null
   * means stat is at level 0. Length is normally 8.
   */
  levels: (number | null)[];
}

/** Map<SkillId, SkillProgress> for fast lookups. */
export type SkillProgressMap = Map<SkillId, SkillProgress>;

/** One concrete upgrade candidate the strategy picks. */
export interface UpgradeCandidate {
  skillId: SkillId;
  statId: StatId;
  /** Current stat level (0..24). */
  fromLevel: number;
  /** Cost in skill points to move from fromLevel → fromLevel+1. */
  cost: number;
}

/** Request body for POST /api/game/skill/levelup. */
export interface LevelUpRequest {
  skillId: SkillId;
  statId: StatId;
  noobId: number;
}

/** Response envelope from /api/game/skill/levelup. The data payload is the
 *  PRE-mutation state; the new level is `oldLevel + 1`. */
export interface LevelUpResponse {
  success: boolean;
  message?: string;
  data?: {
    LEVEL_CID_array?: (number | null)[];
    LEVEL_CID?: number;
    SKILL_CID?: SkillId;
    NOOB_TOKEN_CID?: number;
  };
}
