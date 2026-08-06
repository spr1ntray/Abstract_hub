export interface PricingConfig {
  /** Discount in basis points (100 = 1%). Default 100 (1% below floor). */
  discountBps?: bigint;
  /** Skip items with these rarities. Empty = list all. */
  skipRarities?: number[];
  /** Skip equipped items (EQUIPPED_TO_SLOT_CID > 0). Default true. */
  skipEquipped?: boolean;
  /** Skip if floor < this (wei). Default 0 (don't skip). */
  minFloorWei?: bigint;
}

const DEFAULT_DISCOUNT_BPS = 100n; // 1%

export const PROTECTED_MARKET_ITEMS = {
  21: 'Wood',
  25: 'Stone',
} as const;

export function isProtectedMarketItem(itemId: number): boolean {
  return Object.hasOwn(PROTECTED_MARKET_ITEMS, itemId);
}

export function protectedMarketItemName(itemId: number): string | undefined {
  return PROTECTED_MARKET_ITEMS[itemId as keyof typeof PROTECTED_MARKET_ITEMS];
}

export function computeListPrice(
  floorWei: bigint,
  discountBps: bigint = DEFAULT_DISCOUNT_BPS,
): bigint {
  if (floorWei <= 0n) return 0n;
  return (floorWei * (10_000n - discountBps)) / 10_000n;
}

export interface ItemForListing {
  rarity: number;
  equipped: boolean;
  itemId: number;
}

/** Returns null if the item should be listed, or a reason string if skipped. */
export function shouldSkip(
  item: ItemForListing,
  floorWei: bigint | undefined,
  cfg: PricingConfig = {},
): string | null {
  const protectedName = protectedMarketItemName(item.itemId);
  if (protectedName) return `protected resource: ${protectedName}`;
  const skipEquipped = cfg.skipEquipped ?? true;
  if (skipEquipped && item.equipped) return 'equipped';
  if (cfg.skipRarities && cfg.skipRarities.includes(item.rarity)) {
    return `rarity ${item.rarity} excluded`;
  }
  if (floorWei === undefined || floorWei === 0n) return 'no floor';
  if (cfg.minFloorWei !== undefined && floorWei < cfg.minFloorWei) return 'below minFloorWei';
  return null;
}
