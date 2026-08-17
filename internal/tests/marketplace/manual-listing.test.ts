import { describe, expect, it } from 'vitest';
import type { InventoryRow } from '../../src/inventory.js';
import {
  ManualListingValidationError,
  prepareManualListings,
} from '../../src/marketplace/manual-listing.js';

function row(itemId: number, qty: number, equippedQty = 0): InventoryRow {
  return {
    gameItemId: itemId,
    item: `Item ${itemId}`,
    qty,
    equippedQty,
    rarity: '—',
    equipped: equippedQty > 0,
    unknown: false,
  };
}

describe('prepareManualListings', () => {
  it('uses the exact floor by default for unequipped quantity', () => {
    expect(
      prepareManualListings([row(7, 5, 2)], new Map([[7, 10_000n]]), [{ itemId: 7, amount: 3 }]),
    ).toEqual([
      {
        itemId: 7,
        itemName: 'Item 7',
        amount: 3,
        floorWei: 10_000n,
        priceWei: 10_000n,
      },
    ]);
  });

  it('supports a caller-selected floor discount', () => {
    expect(
      prepareManualListings([row(7, 1)], new Map([[7, 10_000n]]), [{ itemId: 7, amount: 1 }], {
        mode: 'discount',
        discountBps: 250n,
      })[0]?.priceWei,
    ).toBe(9_750n);
  });

  it('supports a custom price even when the item has no floor', () => {
    expect(
      prepareManualListings([row(7, 1)], new Map(), [{ itemId: 7, amount: 1, priceWei: '12345' }], {
        mode: 'custom',
      }),
    ).toEqual([
      {
        itemId: 7,
        itemName: 'Item 7',
        amount: 1,
        floorWei: null,
        priceWei: 12_345n,
      },
    ]);
  });

  it('rejects an amount that includes equipped copies', () => {
    expect(() =>
      prepareManualListings([row(7, 5, 2)], new Map([[7, 10_000n]]), [{ itemId: 7, amount: 4 }]),
    ).toThrow('доступно для продажи 3');
  });

  it.each([
    [21, 'Wood'],
    [25, 'Stone'],
  ])('rejects protected resource %i (%s) before listing', (itemId, name) => {
    expect(() =>
      prepareManualListings([row(itemId, 100)], new Map([[itemId, 10_000n]]), [
        { itemId, amount: 1 },
      ]),
    ).toThrow(ManualListingValidationError);
    expect(() =>
      prepareManualListings([row(itemId, 100)], new Map([[itemId, 10_000n]]), [
        { itemId, amount: 1 },
      ]),
    ).toThrow(name);
  });

  it('rejects duplicate item IDs before any transactions are sent', () => {
    expect(() =>
      prepareManualListings([row(7, 5)], new Map([[7, 10_000n]]), [
        { itemId: 7, amount: 1 },
        { itemId: 7, amount: 1 },
      ]),
    ).toThrow('выбран дважды');
  });

  it('rejects soulbound items before requesting a listing signature', () => {
    expect(() =>
      prepareManualListings(
        [{ ...row(810, 1), item: 'Easter SBT', soulbound: true }],
        new Map([[810, 10_000n]]),
        [{ itemId: 810, amount: 1 }],
      ),
    ).toThrow('soulbound-предмет нельзя продать');
  });
});
