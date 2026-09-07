import type { Database } from "bun:sqlite";
import { openDatabase } from "../core/sqlite.js";

// Local cache. It exists because the history is immutable for finished orders,
// the site is rate-limited, and every analytical question ("quanto gastei em
// lingerie") would otherwise cost a full crawl.
//
// Two rules the schema enforces:
//   - money is INTEGER CENTS, so SUM() is exact;
//   - the raw payloads are kept, so improved parsers can be re-run over the
//     history with zero network (`sync --reparse`).

export const SCHEMA_VERSION = 1;

/** Ordered and append-only: a released migration is never edited. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS orders (
    billno                   TEXT PRIMARY KEY,
    checkout_id              TEXT,             -- relation_billno: groups one checkout
    status                   TEXT NOT NULL,
    status_code              TEXT,
    status_label             TEXT,
    placed_at                TEXT,             -- ISO -03:00
    placed_day               TEXT,             -- YYYY-MM-DD, comparable as a string
    paid_at                  TEXT,
    currency                 TEXT NOT NULL DEFAULT 'BRL',
    total_cents              INTEGER NOT NULL DEFAULT 0,
    subtotal_cents           INTEGER NOT NULL DEFAULT 0,
    retail_cents             INTEGER NOT NULL DEFAULT 0,
    saved_cents              INTEGER NOT NULL DEFAULT 0,
    shipping_cents           INTEGER NOT NULL DEFAULT 0,
    shipping_original_cents  INTEGER NOT NULL DEFAULT 0,
    tax_cents                INTEGER NOT NULL DEFAULT 0,
    installment_fee_cents    INTEGER NOT NULL DEFAULT 0,
    coupon_cents             INTEGER NOT NULL DEFAULT 0,
    points_cents             INTEGER NOT NULL DEFAULT 0,
    wallet_cents             INTEGER NOT NULL DEFAULT 0,
    payment_method           TEXT,
    payment_title            TEXT,
    goods_count              INTEGER NOT NULL DEFAULT 0,
    package_count            INTEGER NOT NULL DEFAULT 0,
    malls                    TEXT,             -- JSON array
    is_multi_mall            INTEGER NOT NULL DEFAULT 0,
    returnable               INTEGER NOT NULL DEFAULT 0,
    archived                 INTEGER NOT NULL DEFAULT 0,
    raw_list                 TEXT,
    raw_detail               TEXT,             -- for offline reparse
    detail_fetched_at        TEXT,
    detail_error             TEXT,
    parser_version           INTEGER,
    updated_at               TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id                TEXT PRIMARY KEY,        -- Shein's own line id
    billno            TEXT NOT NULL REFERENCES orders(billno) ON DELETE CASCADE,
    position          INTEGER NOT NULL DEFAULT 0,
    goods_id          TEXT,
    goods_sn          TEXT,
    sku_code          TEXT,
    name              TEXT,
    attrs             TEXT,
    quantity          INTEGER NOT NULL DEFAULT 1,
    unit_cents        INTEGER NOT NULL DEFAULT 0,
    total_cents       INTEGER NOT NULL DEFAULT 0,
    retail_unit_cents INTEGER NOT NULL DEFAULT 0,
    cat_id            TEXT,
    store_code        TEXT,
    store_name        TEXT,
    mall              TEXT,
    status_code       TEXT,
    package_no        TEXT,
    tracking_number   TEXT,
    returnable        INTEGER NOT NULL DEFAULT 0,
    refund_status     TEXT,
    image_url         TEXT
  );

  CREATE TABLE IF NOT EXISTS order_price_lines (
    billno   TEXT NOT NULL REFERENCES orders(billno) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    type     TEXT NOT NULL,                    -- newSubTotal | shipping | subTax | …
    label    TEXT NOT NULL,                    -- as Shein wrote it
    cents    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (billno, position)
  );

  -- Several orders of one checkout can share a parcel, so the row is per order.
  CREATE TABLE IF NOT EXISTS packages (
    billno          TEXT NOT NULL REFERENCES orders(billno) ON DELETE CASCADE,
    package_no      TEXT NOT NULL,
    tracking_number TEXT,
    carrier         TEXT,
    track_url       TEXT,
    event_count     INTEGER NOT NULL DEFAULT 0,
    last_event_at   TEXT,
    payload_json    TEXT NOT NULL,             -- the events, normalised on read
    tracked_at      TEXT NOT NULL,
    PRIMARY KEY (billno, package_no)
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_orders_day      ON orders(placed_day DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_checkout ON orders(checkout_id);
  CREATE INDEX IF NOT EXISTS idx_items_order     ON order_items(billno);
  CREATE INDEX IF NOT EXISTS idx_items_goods     ON order_items(goods_id);
  CREATE INDEX IF NOT EXISTS idx_items_store     ON order_items(store_name);

  -- FTS over what the user actually remembers: the product name, its colour
  -- and size, and the store. remove_diacritics 2 is what makes "conjunto"
  -- find "Conjunto" and "cafe" find "Café" — the point for a pt-BR catalogue.
  -- ponytail: a plain (not external-content) fts5 table. A personal history is
  -- a few hundred rows, so the duplicated text is nothing and re-indexing one
  -- order is a delete plus an insert. Revisit above tens of thousands of items.
  CREATE VIRTUAL TABLE IF NOT EXISTS order_items_fts USING fts5(
    name,
    attrs,
    store_name,
    item_id UNINDEXED,
    billno UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  `,
];

/** Applies every migration not yet applied. Idempotent. */
export function migrate(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | null;
  const current = row ? Number(row.value) : 0;
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version] as string);
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
        String(version + 1),
      );
    })();
  }
}

export function openCache(path: string): Database {
  const db = openDatabase(path);
  migrate(db);
  return db;
}
