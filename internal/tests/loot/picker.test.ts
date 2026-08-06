import { describe, it, expect } from 'vitest';
import { decideLoot } from '../../src/loot/picker.js';
import type { LootOption } from '../../src/loot/types.js';
import type { BattleState } from '../../src/combat/types.js';

const plan = {
  priorities: { UpgradeRock_ATK: 100, AddMaxHealth: 50, UpgradePaper: 5 },
  defaultScore: 10,
  rules: [
    {
      when: 'me.health.current / me.health.currentMax < 0.4',
      boost: { Heal: 200, AddMaxHealth: 100 },
    },
  ],
};

function mkOpt(boon: string): LootOption {
  return {
    docId: '',
    RARITY_CID: 0,
    UINT256_CID: 0,
    selectedVal1: 1,
    selectedVal2: 0,
    boonTypeString: boon,
  };
}

const fullHpState: BattleState = {
  me: {
    health: { current: 20, starting: 20, currentMax: 20, startingMax: 20 },
  } as unknown as BattleState['me'],
  enemy: {} as unknown as BattleState['enemy'],
  room: 1,
  dungeonId: 1,
};

describe('decideLoot', () => {
  it('picks highest priority boon (index 1-based)', () => {
    const opts = [mkOpt('AddMaxHealth'), mkOpt('UpgradeRock_ATK'), mkOpt('UpgradePaper')];
    expect(decideLoot(opts, fullHpState, plan)).toBe(2);
  });

  it('uses defaultScore for unknown boon', () => {
    const opts = [mkOpt('SomeUnknownBoonXYZ'), mkOpt('UpgradePaper')];
    expect(decideLoot(opts, fullHpState, plan)).toBe(1); // 10 > 5
  });

  it('applies low-hp rule', () => {
    const lowHpState: BattleState = {
      me: {
        health: { current: 3, starting: 20, currentMax: 20, startingMax: 20 },
      } as unknown as BattleState['me'],
      enemy: {} as unknown as BattleState['enemy'],
      room: 1,
      dungeonId: 1,
    };
    const opts = [mkOpt('UpgradeRock_ATK'), mkOpt('AddMaxHealth')]; // 100 vs 50+100=150
    expect(decideLoot(opts, lowHpState, plan)).toBe(2);
  });

  it('throws when options array is empty', () => {
    expect(() => decideLoot([], fullHpState, plan)).toThrow();
  });
});
