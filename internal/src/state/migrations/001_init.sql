CREATE TABLE IF NOT EXISTS listings (
  gear_instance_id TEXT PRIMARY KEY,
  item_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'submitted', 'confirmed', 'failed', 'skipped')),
  tx_hash TEXT,
  price_wei TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_snapshots (
  taken_at INTEGER PRIMARY KEY,
  gear_instance_ids TEXT NOT NULL  -- JSON array
);

CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
