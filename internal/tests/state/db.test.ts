import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateDB } from '../../src/state/db.js';

describe('StateDB', () => {
  let dir: string;
  let db: StateDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sdb-'));
    db = new StateDB(join(dir, 'state.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('upserts and reads listings', () => {
    db.upsertListing({ gear_instance_id: 'a', item_id: 1, status: 'pending' });
    const got = db.getListing('a');
    expect(got?.status).toBe('pending');
    expect(got?.item_id).toBe(1);
  });

  it('updates existing listing on conflict (preserves earlier non-null fields)', () => {
    db.upsertListing({
      gear_instance_id: 'a',
      item_id: 1,
      status: 'pending',
      price_wei: '100',
    });
    db.upsertListing({
      gear_instance_id: 'a',
      item_id: 1,
      status: 'confirmed',
      tx_hash: '0xab',
      // price_wei intentionally omitted on update — should be preserved
    });
    const got = db.getListing('a');
    expect(got?.status).toBe('confirmed');
    expect(got?.tx_hash).toBe('0xab');
    expect(got?.price_wei).toBe('100');
  });

  it('snapshots roundtrip', () => {
    db.recordSnapshot(['a', 'b', 'c']);
    const snap = db.latestSnapshot();
    expect(snap?.ids).toEqual(['a', 'b', 'c']);
  });

  it('alreadyListed identifies items not in the listings table', () => {
    db.upsertListing({ gear_instance_id: 'a', item_id: 1, status: 'confirmed' });
    db.upsertListing({ gear_instance_id: 'b', item_id: 2, status: 'failed' });
    const result = db.alreadyListed(['a', 'b', 'c']);
    expect(result.has('a')).toBe(true); // confirmed → already listed
    expect(result.has('b')).toBe(false); // failed → can retry
    expect(result.has('c')).toBe(false); // not seen
  });
});
