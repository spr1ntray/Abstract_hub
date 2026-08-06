import { describe, it, expect } from 'vitest';
import { diffInventory, asListable, extractInventory } from '../../src/marketplace/inventory.js';
import type { GearInstance, ActionResponse } from '../../src/api/types.js';

function mkGear(docId: string, over: Partial<GearInstance> = {}): GearInstance {
  return {
    _id: 'id-' + docId,
    docId,
    GAME_ITEM_ID_CID: 1,
    RARITY_CID: 0,
    EQUIPPED_TO_SLOT_CID: 0,
    DURABILITY_CID: 100,
    ...over,
  };
}

describe('diffInventory', () => {
  it('returns only new items', () => {
    const before = [mkGear('a'), mkGear('b')];
    const after = [mkGear('a'), mkGear('b'), mkGear('c'), mkGear('d')];
    expect(diffInventory(before, after).map((g) => g.docId)).toEqual(['c', 'd']);
  });

  it('empty when nothing changed', () => {
    const before = [mkGear('a'), mkGear('b')];
    const after = [mkGear('a'), mkGear('b')];
    expect(diffInventory(before, after)).toEqual([]);
  });

  it('handles empty before', () => {
    expect(diffInventory([], [mkGear('a')]).map((g) => g.docId)).toEqual(['a']);
  });
});

describe('asListable', () => {
  it('maps rarity + slot + itemId', () => {
    expect(
      asListable(mkGear('x', { GAME_ITEM_ID_CID: 42, RARITY_CID: 2, EQUIPPED_TO_SLOT_CID: 0 })),
    ).toEqual({ itemId: 42, rarity: 2, equipped: false });
  });

  it('equipped when slot > 0', () => {
    expect(asListable(mkGear('x', { EQUIPPED_TO_SLOT_CID: 3 })).equipped).toBe(true);
  });
});

describe('extractInventory', () => {
  it('reads gearInstances from action response', () => {
    const res = {
      data: {
        entity: { data: { gearInstances: [mkGear('a')], roomInvaderItemsEarned: [] } },
      },
    } as unknown as ActionResponse;
    expect(extractInventory(res).map((g) => g.docId)).toEqual(['a']);
  });

  it('returns empty when no gearInstances', () => {
    const res = {
      data: { entity: { data: {} } },
    } as unknown as ActionResponse;
    expect(extractInventory(res)).toEqual([]);
  });
});
