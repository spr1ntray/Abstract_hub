import type { Logger } from 'pino';
import type { GigaClient } from '../api/client.js';
import type { GearInstance } from '../api/types.js';
import type { StateDB } from '../state/db.js';
import { computeListPrice, shouldSkip, type PricingConfig } from './pricing.js';
import {
  listOne,
  type MarketplaceListingPolicyReader,
  type MarketplaceTransactionSender,
} from './lister.js';
import { asListable } from './inventory.js';

export interface SellSummary {
  considered: number;
  listed: number;
  skipped: number;
  failed: number;
}

export async function sellNewItems(opts: {
  giga: GigaClient;
  agw: MarketplaceTransactionSender;
  db: StateDB;
  sellerAddress: string;
  listingPolicyReader?: MarketplaceListingPolicyReader;
  newItems: GearInstance[];
  pricingConfig?: PricingConfig;
  log: Logger;
}): Promise<SellSummary> {
  const { giga, agw, db, sellerAddress, newItems, pricingConfig, log } = opts;
  const summary: SellSummary = { considered: newItems.length, listed: 0, skipped: 0, failed: 0 };

  if (newItems.length === 0) {
    log.info('sell: no new items');
    return summary;
  }

  // Filter out already-listed (idempotent across crashes)
  const ids = newItems.map((g) => g.docId);
  const alreadyListed = db.alreadyListed(ids);
  const toConsider = newItems.filter((g) => !alreadyListed.has(g.docId));
  if (toConsider.length < newItems.length) {
    log.info(
      { skipped_already: newItems.length - toConsider.length },
      'sell: already-listed skipped',
    );
  }

  log.info('sell: fetching floors');
  const floors = await giga.getFloors();

  for (const gear of toConsider) {
    const listable = asListable(gear);
    const floor = floors.get(listable.itemId);
    const skipReason = shouldSkip(listable, floor, pricingConfig);

    if (skipReason) {
      log.info({ gear: gear.docId, itemId: listable.itemId, reason: skipReason }, 'sell: skip');
      db.upsertListing({
        gear_instance_id: gear.docId,
        item_id: listable.itemId,
        status: 'skipped',
        reason: skipReason,
      });
      summary.skipped++;
      continue;
    }

    const priceWei = computeListPrice(floor!, pricingConfig?.discountBps);
    db.upsertListing({
      gear_instance_id: gear.docId,
      item_id: listable.itemId,
      status: 'pending',
      price_wei: priceWei.toString(),
    });

    try {
      const { txHash } = await listOne({
        giga,
        agw,
        itemId: listable.itemId,
        priceWei,
        sellerAddress,
        ...(opts.listingPolicyReader ? { listingPolicyReader: opts.listingPolicyReader } : {}),
        log,
      });
      db.upsertListing({
        gear_instance_id: gear.docId,
        item_id: listable.itemId,
        status: 'submitted',
        tx_hash: txHash,
        price_wei: priceWei.toString(),
      });
      summary.listed++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error({ gear: gear.docId, err: e }, 'sell: list failed');
      db.upsertListing({
        gear_instance_id: gear.docId,
        item_id: listable.itemId,
        status: 'failed',
        reason: msg,
        price_wei: priceWei.toString(),
      });
      summary.failed++;
    }
  }

  log.info(summary, 'sell phase done');
  return summary;
}
