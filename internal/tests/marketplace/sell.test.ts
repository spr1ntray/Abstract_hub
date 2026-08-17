import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { sellNewItems } from '../../src/marketplace/sell.js';
import { StateDB } from '../../src/state/db.js';
import type { GigaClient } from '../../src/api/client.js';
import type { AgwSigner } from '../../src/wallet/signer.js';
import type { GearInstance } from '../../src/api/types.js';

const silentLog = pino({ level: 'silent' });
const sellerAddress = '0x1111111111111111111111111111111111111111';
const freePolicyReader = vi.fn().mockResolvedValue({
  isPlayerJuiced: true,
  unjuicedListingEnabled: true,
  unjuicedListingFeeWei: 250_000_000_000_000n,
  feeWei: 0n,
  blocked: false,
});

function mkGear(docId: string, over: Partial<GearInstance> = {}): GearInstance {
  return {
    _id: 'id-' + docId,
    docId,
    GAME_ITEM_ID_CID: 100,
    RARITY_CID: 0,
    EQUIPPED_TO_SLOT_CID: 0,
    DURABILITY_CID: 100,
    ...over,
  };
}

describe('sellNewItems', () => {
  let dir: string;
  let db: StateDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sell-'));
    db = new StateDB(join(dir, 's.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists newly-acquired items at floor-1%', async () => {
    const giga = {
      getFloors: vi.fn().mockResolvedValue(new Map([[100, 1_000_000n]])),
      post: vi.fn().mockResolvedValue({ signature: '0xsig', nonce: 1 }),
    } as unknown as GigaClient;
    const agw = {
      sendTransaction: vi.fn().mockResolvedValue('0xtx'),
    } as unknown as AgwSigner;

    const summary = await sellNewItems({
      giga,
      agw,
      db,
      sellerAddress,
      listingPolicyReader: freePolicyReader,
      newItems: [mkGear('g1')],
      log: silentLog,
    });

    expect(summary).toEqual({ considered: 1, listed: 1, skipped: 0, failed: 0 });

    const row = db.getListing('g1');
    expect(row?.status).toBe('submitted');
    expect(row?.price_wei).toBe('990000'); // 1_000_000 * 99/100
    expect(row?.tx_hash).toBe('0xtx');
  });

  it('skips equipped items', async () => {
    const giga = {
      getFloors: vi.fn().mockResolvedValue(new Map([[100, 1_000_000n]])),
      post: vi.fn(),
    } as unknown as GigaClient;
    const agw = { sendTransaction: vi.fn() } as unknown as AgwSigner;

    const summary = await sellNewItems({
      giga,
      agw,
      db,
      sellerAddress,
      newItems: [mkGear('g1', { EQUIPPED_TO_SLOT_CID: 1 })],
      log: silentLog,
    });

    expect(summary).toEqual({ considered: 1, listed: 0, skipped: 1, failed: 0 });
    const row = db.getListing('g1');
    expect(row?.status).toBe('skipped');
    expect(row?.reason).toBe('equipped');
    expect(giga.post).not.toHaveBeenCalled();
  });

  it('skips already-listed (idempotency)', async () => {
    db.upsertListing({ gear_instance_id: 'g1', item_id: 100, status: 'confirmed' });

    const giga = {
      getFloors: vi.fn().mockResolvedValue(new Map([[100, 1_000_000n]])),
      post: vi.fn(),
    } as unknown as GigaClient;
    const agw = { sendTransaction: vi.fn() } as unknown as AgwSigner;

    const summary = await sellNewItems({
      giga,
      agw,
      db,
      sellerAddress,
      newItems: [mkGear('g1')],
      log: silentLog,
    });

    expect(summary.listed).toBe(0);
    expect(giga.post).not.toHaveBeenCalled();
  });

  it('records failures', async () => {
    const giga = {
      getFloors: vi.fn().mockResolvedValue(new Map([[100, 1_000_000n]])),
      post: vi.fn().mockResolvedValue({ signature: '0xsig', nonce: 1 }),
    } as unknown as GigaClient;
    const agw = {
      sendTransaction: vi.fn().mockRejectedValue(new Error('insufficient gas')),
    } as unknown as AgwSigner;

    const summary = await sellNewItems({
      giga,
      agw,
      db,
      sellerAddress,
      listingPolicyReader: freePolicyReader,
      newItems: [mkGear('g1')],
      log: silentLog,
    });

    expect(summary.failed).toBe(1);
    const row = db.getListing('g1');
    expect(row?.status).toBe('failed');
    expect(row?.reason).toContain('insufficient gas');
  });
});
