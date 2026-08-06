import type { ActionResponse, GearInstance } from '../api/types.js';

/** Extract current inventory from any action response. */
export function extractInventory(res: ActionResponse): GearInstance[] {
  return res.data.entity.data.gearInstances ?? [];
}

/** Items in `after` that are not in `before`, identified by stable `docId`. */
export function diffInventory(before: GearInstance[], after: GearInstance[]): GearInstance[] {
  const beforeIds = new Set(before.map((g) => g.docId));
  return after.filter((g) => !beforeIds.has(g.docId));
}

/** Convert a GearInstance into the shape `shouldSkip` expects. */
export function asListable(g: GearInstance): {
  rarity: number;
  equipped: boolean;
  itemId: number;
} {
  return {
    rarity: g.RARITY_CID,
    equipped: g.EQUIPPED_TO_SLOT_CID > 0,
    itemId: g.GAME_ITEM_ID_CID,
  };
}
