import { describe, it, expect } from 'vitest';
import {
  pickNextUpgrade,
  applyUpgradeLocally,
  DEFAULT_ALLOWED_SKILLS,
  DEFAULT_ALLOWED_STATS,
} from '../../src/skills/strategy.js';
import type { SkillCatalog, SkillProgressMap, SkillCatalogEntry } from '../../src/skills/types.js';

const REAL_LPP = [1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4];

function mkCatalogEntry(id: 1 | 2 | 3 | 4, name: string): SkillCatalogEntry {
  return {
    docId: String(id),
    name,
    stats: [
      { id: 0, name: 'Sword ATK', levelsPerPoint: REAL_LPP },
      { id: 1, name: 'Sword DEF', levelsPerPoint: REAL_LPP },
      { id: 2, name: 'Shield ATK', levelsPerPoint: REAL_LPP },
      { id: 3, name: 'Shield DEF', levelsPerPoint: REAL_LPP },
      { id: 4, name: 'Spell ATK', levelsPerPoint: REAL_LPP },
      { id: 5, name: 'Spell DEF', levelsPerPoint: REAL_LPP },
      { id: 6, name: 'Max HP', levelsPerPoint: REAL_LPP },
      { id: 7, name: 'Max AMR', levelsPerPoint: REAL_LPP },
    ],
  };
}

function mkCatalog(): SkillCatalog {
  const m: SkillCatalog = new Map();
  m.set(1, mkCatalogEntry(1, 'Dungetron 5000'));
  m.set(2, mkCatalogEntry(2, 'Underhaul'));
  return m;
}

function mkProgress(skillLevels: Record<number, (number | null)[]>): SkillProgressMap {
  const m: SkillProgressMap = new Map();
  for (const [id, levels] of Object.entries(skillLevels)) {
    const k = Number(id) as 1 | 2 | 3 | 4;
    m.set(k, { SKILL_CID: k, NOOB_TOKEN_CID: 42, levels });
  }
  return m;
}

describe('pickNextUpgrade', () => {
  it('finishes the configured combat tree before moving to the next one', () => {
    // Skill 2 is cheaper, but Dungetron is first in the configured tree order.
    const progress = mkProgress({
      1: [9, 9, 0, 0, 0, 0, 0, 0],
      2: [0, 0, 0, 0, 0, 0, 0, 0],
    });
    const c = pickNextUpgrade(mkCatalog(), progress);
    expect(c?.skillId).toBe(1);
    expect(c?.statId).toBe(0);
    expect(c?.cost).toBe(2);
  });

  it('finishes sword in every configured tree before touching armor', () => {
    const progress = mkProgress({
      1: [25, 25, 0, 0, 0, 0, 0, 0],
      2: [24, 25, 0, 0, 0, 0, 0, 0],
    });
    const c = pickNextUpgrade(mkCatalog(), progress);
    expect(c?.skillId).toBe(2);
    expect(c?.statId).toBe(0);
  });

  it('keeps attack and defence balanced inside the active pair', () => {
    const progress = mkProgress({ 1: [8, 3, 0, 0, 0, 0, 0, 0] });
    const c = pickNextUpgrade(mkCatalog(), progress);
    expect(c?.statId).toBe(1);
    expect(c?.fromLevel).toBe(3);
  });

  it('ignores HP (id=6) and MaxAMR (id=7) by default', () => {
    // Only HP and MaxAMR available below max — neither should be picked
    const progress = mkProgress({
      1: [25, 25, 25, 25, 25, 25, 0, 0], // 0-5 maxed, only 6 and 7 left
    });
    const c = pickNextUpgrade(mkCatalog(), progress);
    expect(c).toBeNull();
  });

  it('returns null when every allowed stat is maxed', () => {
    const progress = mkProgress({
      1: [25, 25, 25, 25, 25, 25, 25, 25],
      2: [25, 25, 25, 25, 25, 25, 25, 25],
    });
    expect(pickNextUpgrade(mkCatalog(), progress)).toBeNull();
  });

  it('respects custom allowedStats — sword-only mode', () => {
    const progress = mkProgress({ 1: [10, 10, 0, 0, 0, 0, 0, 0] });
    const c = pickNextUpgrade(mkCatalog(), progress, { allowedStats: [0, 1] });
    // 2,3,4,5 are off the table — sword 0/1 at lvl 10 means cost=2
    expect(c?.cost).toBe(2);
    expect([0, 1]).toContain(c?.statId);
  });

  it('respects custom allowedSkills — skill 1 only', () => {
    const progress = mkProgress({
      1: [0, 0, 0, 0, 0, 0, 0, 0],
      2: [0, 0, 0, 0, 0, 0, 0, 0],
    });
    const c = pickNextUpgrade(mkCatalog(), progress, { allowedSkills: [1] });
    expect(c?.skillId).toBe(1);
  });

  it('never treats Fishing as a combat tree by default', () => {
    const catalog = mkCatalog();
    catalog.set(3, mkCatalogEntry(3, 'Fishing Skills'));
    const progress = mkProgress({ 3: [0, 0, 0, 0, 0, 0, 0, 0] });

    expect(pickNextUpgrade(catalog, progress)).toBeNull();
  });

  it('ties on cost are broken by priority order (sword > armor > crystal)', () => {
    // All allowed stats at level 0 (cost 1). Priority should pick SwordATK first.
    const progress = mkProgress({ 1: [0, 0, 0, 0, 0, 0, 0, 0] });
    const c = pickNextUpgrade(mkCatalog(), progress);
    expect(c?.statId).toBe(0); // SwordATK wins
  });

  it('skips stats already at max even when others are cheaper', () => {
    const progress = mkProgress({ 1: [25, 0, 0, 0, 0, 0, 0, 0] });
    const c = pickNextUpgrade(mkCatalog(), progress);
    expect(c?.statId).not.toBe(0);
    expect([1, 2, 3, 4, 5]).toContain(c?.statId);
  });

  it('exports DEFAULT_ALLOWED_STATS as sword+armor+crystal (0..5)', () => {
    expect(DEFAULT_ALLOWED_STATS).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('exports only the two combat trees by default', () => {
    expect(DEFAULT_ALLOWED_SKILLS).toEqual([1, 2]);
  });
});

describe('applyUpgradeLocally', () => {
  it('increments the target stat without mutating the original', () => {
    const p = mkProgress({ 1: [3, 5, 0, 0, 0, 0, 0, 0] });
    const next = applyUpgradeLocally(p, { skillId: 1, statId: 0, fromLevel: 3, cost: 1 });
    expect(next.get(1)?.levels[0]).toBe(4);
    // Original untouched
    expect(p.get(1)?.levels[0]).toBe(3);
  });

  it('pads the levels array if statId is past the end', () => {
    const p = mkProgress({ 1: [1] });
    const next = applyUpgradeLocally(p, { skillId: 1, statId: 3, fromLevel: 0, cost: 1 });
    expect(next.get(1)?.levels[3]).toBe(1);
    expect(next.get(1)?.levels[0]).toBe(1);
  });
});
