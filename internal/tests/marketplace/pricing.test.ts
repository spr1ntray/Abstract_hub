import { describe, it, expect } from 'vitest';
import {
  computeListPrice,
  isProtectedMarketItem,
  shouldSkip,
} from '../../src/marketplace/pricing.js';

describe('computeListPrice', () => {
  it('default 1% discount', () => {
    expect(computeListPrice(100_000_000_000_000n)).toBe(99_000_000_000_000n);
  });

  it('zero floor → zero', () => {
    expect(computeListPrice(0n)).toBe(0n);
  });

  it('custom 5% discount', () => {
    expect(computeListPrice(1_000_000n, 500n)).toBe(950_000n);
  });
});

describe('shouldSkip', () => {
  it('always protects Wood and Stone from listing', () => {
    expect(isProtectedMarketItem(21)).toBe(true);
    expect(isProtectedMarketItem(25)).toBe(true);
    expect(shouldSkip({ rarity: 0, equipped: false, itemId: 21 }, 5_000n)).toBe(
      'protected resource: Wood',
    );
    expect(shouldSkip({ rarity: 0, equipped: false, itemId: 25 }, 5_000n)).toBe(
      'protected resource: Stone',
    );
  });

  it('skips equipped by default', () => {
    expect(shouldSkip({ rarity: 0, equipped: true, itemId: 1 }, 5_000n)).toBe('equipped');
  });

  it('allows equipped when skipEquipped: false', () => {
    expect(
      shouldSkip({ rarity: 0, equipped: true, itemId: 1 }, 5_000n, { skipEquipped: false }),
    ).toBeNull();
  });

  it('skips by rarity', () => {
    expect(
      shouldSkip({ rarity: 3, equipped: false, itemId: 1 }, 5_000n, { skipRarities: [2, 3] }),
    ).toMatch(/rarity/);
  });

  it('skips when no floor', () => {
    expect(shouldSkip({ rarity: 0, equipped: false, itemId: 1 }, undefined)).toBe('no floor');
    expect(shouldSkip({ rarity: 0, equipped: false, itemId: 1 }, 0n)).toBe('no floor');
  });

  it('skips when below min', () => {
    expect(
      shouldSkip({ rarity: 0, equipped: false, itemId: 1 }, 100n, { minFloorWei: 1_000n }),
    ).toBe('below minFloorWei');
  });

  it('passes through good case', () => {
    expect(shouldSkip({ rarity: 0, equipped: false, itemId: 1 }, 50_000n)).toBeNull();
  });
});
