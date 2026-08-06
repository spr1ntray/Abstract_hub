import type { InventoryRow } from '../inventory.js';
import { computeListPrice, protectedMarketItemName } from './pricing.js';

export interface ManualListingSelection {
  itemId: number;
  amount: number;
  /** Decimal wei string, required only for custom pricing. */
  priceWei?: string;
}

export type ManualListingPricing =
  | { mode: 'floor' }
  | { mode: 'discount'; discountBps: bigint }
  | { mode: 'custom' };

export interface PreparedManualListing {
  itemId: number;
  itemName: string;
  amount: number;
  floorWei: bigint | null;
  priceWei: bigint;
}

export class ManualListingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualListingValidationError';
  }
}

/** Validate the complete batch before any irreversible listing is submitted. */
export function prepareManualListings(
  inventory: InventoryRow[],
  floors: Map<number, bigint>,
  selections: ManualListingSelection[],
  pricing: ManualListingPricing = { mode: 'floor' },
): PreparedManualListing[] {
  if (selections.length === 0) {
    throw new ManualListingValidationError('Не выбраны предметы для продажи');
  }
  if (selections.length > 24) {
    throw new ManualListingValidationError('За один раз можно выставить не более 24 предметов');
  }

  const rows = new Map(inventory.map((row) => [row.gameItemId, row]));
  const seen = new Set<number>();

  return selections.map((selection) => {
    const { itemId, amount } = selection;
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      throw new ManualListingValidationError('Некорректный ID предмета');
    }
    if (seen.has(itemId)) {
      throw new ManualListingValidationError(`Предмет item#${itemId} выбран дважды`);
    }
    seen.add(itemId);

    const protectedName = protectedMarketItemName(itemId);
    if (protectedName) {
      throw new ManualListingValidationError(
        `${protectedName} защищен от продажи: ресурс нужен для крафта перчаток`,
      );
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new ManualListingValidationError(`Некорректное количество для item#${itemId}`);
    }

    const row = rows.get(itemId);
    if (!row) {
      throw new ManualListingValidationError(`item#${itemId} больше не найден в инвентаре`);
    }
    const available = Math.max(0, row.qty - row.equippedQty);
    if (amount > available) {
      throw new ManualListingValidationError(
        `${row.item}: доступно для продажи ${available}, запрошено ${amount}`,
      );
    }

    const rawFloor = floors.get(itemId);
    const floorWei = rawFloor !== undefined && rawFloor > 0n ? rawFloor : null;
    let priceWei: bigint;
    if (pricing.mode === 'custom') {
      if (!selection.priceWei || !/^\d+$/.test(selection.priceWei)) {
        throw new ManualListingValidationError(`${row.item}: укажите собственную цену`);
      }
      try {
        priceWei = BigInt(selection.priceWei);
      } catch {
        throw new ManualListingValidationError(`${row.item}: некорректная собственная цена`);
      }
    } else {
      if (floorWei === null) {
        throw new ManualListingValidationError(`${row.item}: на Gigamarket нет floor-цены`);
      }
      if (
        pricing.mode === 'discount' &&
        (pricing.discountBps < 0n || pricing.discountBps >= 10_000n)
      ) {
        throw new ManualListingValidationError('Скидка от floor должна быть от 0% до 99.99%');
      }
      priceWei = computeListPrice(floorWei, pricing.mode === 'discount' ? pricing.discountBps : 0n);
    }
    if (priceWei <= 0n) {
      throw new ManualListingValidationError(`${row.item}: рассчитана некорректная цена`);
    }

    return { itemId, itemName: row.item, amount, floorWei, priceWei };
  });
}
