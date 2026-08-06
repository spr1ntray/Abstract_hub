import { describe, it, expect } from 'vitest';
import {
  parseSkillCatalog,
  parseSkillProgress,
  nextUpgradeCost,
  currentStatLevel,
  maxStatLevel,
} from '../../src/skills/parse.js';

// Real cost schedule from HAR: 1pt for levels 1-9, 2pt for 10-16, 3pt for 17-22, 4pt for 23-25.
const REAL_LPP = [1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4];

describe('parseSkillCatalog', () => {
  it('parses an entities-wrapped catalog with multiple skills', () => {
    const raw = {
      entities: [
        {
          docId: '1',
          name: 'Dungetron 5000',
          GAME_ITEM_ID_CID: 2,
          stats: [
            { id: 0, name: 'Sword ATK', levelsPerPoint: REAL_LPP, increaseKey: 'rock' },
            { id: 1, name: 'Sword DEF', levelsPerPoint: REAL_LPP },
          ],
        },
        {
          docId: '2',
          name: 'Underhaul',
          stats: [{ id: 0, name: 'Sword ATK', levelsPerPoint: REAL_LPP }],
        },
      ],
    };
    const cat = parseSkillCatalog(raw);
    expect(cat.size).toBe(2);
    expect(cat.get(1)?.name).toBe('Dungetron 5000');
    expect(cat.get(1)?.stats).toHaveLength(2);
    expect(cat.get(1)?.GAME_ITEM_ID_CID).toBe(2);
  });

  it('skips entries with unknown docId', () => {
    const raw = { entities: [{ docId: '99', name: 'Bogus', stats: [] }] };
    expect(parseSkillCatalog(raw).size).toBe(0);
  });

  it('skips stats with out-of-range id', () => {
    const raw = {
      entities: [{ docId: '1', name: 'X', stats: [{ id: 99, levelsPerPoint: REAL_LPP }] }],
    };
    expect(parseSkillCatalog(raw).get(1)?.stats).toHaveLength(0);
  });

  it('returns empty map for null/empty input', () => {
    expect(parseSkillCatalog(null).size).toBe(0);
    expect(parseSkillCatalog({}).size).toBe(0);
    expect(parseSkillCatalog({ entities: [] }).size).toBe(0);
  });
});

describe('parseSkillProgress', () => {
  it('extracts LEVEL_CID_array and SKILL_CID per entity', () => {
    const raw = {
      entities: [
        {
          docId: 'SKILLPROGRESS#1#81934',
          SKILL_CID: 1,
          NOOB_TOKEN_CID: 81934,
          LEVEL_CID: 4,
          LEVEL_CID_array: [1, 2, null, null, null, null, null, 1],
        },
      ],
    };
    const prog = parseSkillProgress(raw);
    expect(prog.size).toBe(1);
    expect(prog.get(1)?.NOOB_TOKEN_CID).toBe(81934);
    expect(prog.get(1)?.levels).toEqual([1, 2, null, null, null, null, null, 1]);
  });

  it('treats missing LEVEL_CID_array as empty list', () => {
    const raw = { entities: [{ SKILL_CID: 2, NOOB_TOKEN_CID: 1 }] };
    expect(parseSkillProgress(raw).get(2)?.levels).toEqual([]);
  });

  it('ignores entries with bad SKILL_CID', () => {
    const raw = { entities: [{ SKILL_CID: 99, LEVEL_CID_array: [1] }] };
    expect(parseSkillProgress(raw).size).toBe(0);
  });
});

describe('nextUpgradeCost', () => {
  const stat = {
    id: 0 as const,
    name: 'X',
    levelsPerPoint: REAL_LPP,
  };

  it('returns 1 for levels 0..8 (upgrading 1..9)', () => {
    for (let lvl = 0; lvl < 9; lvl++) {
      expect(nextUpgradeCost(stat, lvl)).toBe(1);
    }
  });

  it('returns 2 for levels 9..15 (upgrading 10..16)', () => {
    for (let lvl = 9; lvl < 16; lvl++) {
      expect(nextUpgradeCost(stat, lvl)).toBe(2);
    }
  });

  it('returns 3 for levels 16..21', () => {
    for (let lvl = 16; lvl < 22; lvl++) {
      expect(nextUpgradeCost(stat, lvl)).toBe(3);
    }
  });

  it('returns 4 for levels 22..24 (capping at 25)', () => {
    for (let lvl = 22; lvl < 25; lvl++) {
      expect(nextUpgradeCost(stat, lvl)).toBe(4);
    }
  });

  it('returns Infinity at and beyond max level', () => {
    expect(nextUpgradeCost(stat, 25)).toBe(Infinity);
    expect(nextUpgradeCost(stat, 100)).toBe(Infinity);
    expect(nextUpgradeCost(stat, -1)).toBe(Infinity);
  });
});

describe('currentStatLevel', () => {
  const prog = {
    SKILL_CID: 1 as const,
    NOOB_TOKEN_CID: 1,
    levels: [3, null, 5, null, null, null, null, null],
  };

  it('returns the numeric level', () => {
    expect(currentStatLevel(prog, 0)).toBe(3);
    expect(currentStatLevel(prog, 2)).toBe(5);
  });

  it('treats null as 0', () => {
    expect(currentStatLevel(prog, 1)).toBe(0);
    expect(currentStatLevel(prog, 7)).toBe(0);
  });

  it('treats out-of-range index as 0', () => {
    expect(currentStatLevel({ ...prog, levels: [] }, 0)).toBe(0);
  });
});

describe('maxStatLevel', () => {
  it('returns 25 for the live API schedule', () => {
    expect(maxStatLevel({ id: 0, name: 'X', levelsPerPoint: REAL_LPP })).toBe(25);
  });
});
