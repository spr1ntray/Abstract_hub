import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ListingStatus = 'pending' | 'submitted' | 'confirmed' | 'failed' | 'skipped';

export interface ListingRow {
  gear_instance_id: string;
  item_id: number;
  status: ListingStatus;
  tx_hash: string | null;
  price_wei: string | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface UpsertListing {
  gear_instance_id: string;
  item_id: number;
  status: ListingStatus;
  tx_hash?: string;
  price_wei?: string;
  reason?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export class StateDB {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    // Resolve migration relative to this file so it works both in src/ and dist/
    const sqlPath = resolve(__dirname, 'migrations', '001_init.sql');
    const sql = readFileSync(sqlPath, 'utf8');
    this.db.exec(sql);
  }

  recordSnapshot(gearInstanceIds: string[]): void {
    this.db
      .prepare('INSERT INTO inventory_snapshots (taken_at, gear_instance_ids) VALUES (?, ?)')
      .run(Date.now(), JSON.stringify(gearInstanceIds));
  }

  latestSnapshot(): { taken_at: number; ids: string[] } | null {
    const row = this.db
      .prepare(
        'SELECT taken_at, gear_instance_ids FROM inventory_snapshots ORDER BY taken_at DESC LIMIT 1',
      )
      .get() as { taken_at: number; gear_instance_ids: string } | undefined;
    if (!row) return null;
    return { taken_at: row.taken_at, ids: JSON.parse(row.gear_instance_ids) as string[] };
  }

  upsertListing(row: UpsertListing): void {
    const now = Date.now();
    this.db
      .prepare(
        `
      INSERT INTO listings (gear_instance_id, item_id, status, tx_hash, price_wei, reason, created_at, updated_at)
      VALUES (@gear_instance_id, @item_id, @status, @tx_hash, @price_wei, @reason, @now, @now)
      ON CONFLICT (gear_instance_id) DO UPDATE SET
        status = excluded.status,
        tx_hash = COALESCE(excluded.tx_hash, listings.tx_hash),
        price_wei = COALESCE(excluded.price_wei, listings.price_wei),
        reason = COALESCE(excluded.reason, listings.reason),
        updated_at = @now
    `,
      )
      .run({
        gear_instance_id: row.gear_instance_id,
        item_id: row.item_id,
        status: row.status,
        tx_hash: row.tx_hash ?? null,
        price_wei: row.price_wei ?? null,
        reason: row.reason ?? null,
        now,
      });
  }

  getListing(gearInstanceId: string): ListingRow | null {
    const row = this.db
      .prepare('SELECT * FROM listings WHERE gear_instance_id = ?')
      .get(gearInstanceId) as ListingRow | undefined;
    return row ?? null;
  }

  /** Returns gear_instance_ids that already have a non-failed listing row. */
  alreadyListed(gearInstanceIds: string[]): Set<string> {
    if (gearInstanceIds.length === 0) return new Set();
    const placeholders = gearInstanceIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT gear_instance_id FROM listings WHERE gear_instance_id IN (${placeholders}) AND status IN ('pending','submitted','confirmed','skipped')`,
      )
      .all(...gearInstanceIds) as { gear_instance_id: string }[];
    return new Set(rows.map((r) => r.gear_instance_id));
  }

  close(): void {
    this.db.close();
  }
}
