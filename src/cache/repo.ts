import type { Database } from "bun:sqlite";
import { type Binding, Where, inTx } from "../core/sqlite.js";
import type { OrderStatus } from "../domain/status.js";
import type { Order, OrderSummary, Package } from "../domain/types.js";
import {
  type ItemRow,
  type OrderRow,
  type PackageRow,
  type PriceLineRow,
  itemRows,
  orderOf,
  orderRow,
  packageOf,
  packageRows,
  priceLineRows,
  summaryOf,
  summaryRow,
} from "./rows.js";

// All the SQL lives here. Every value a caller supplies is a `?` parameter,
// never interpolated — including the search query, which is quoted for fts5.

export type OrderFilters = {
  status?: OrderStatus | undefined;
  /** Inclusive, `YYYY-MM-DD`, in Brasília days. */
  from?: string | undefined;
  to?: string | undefined;
  store?: string | undefined;
  checkoutId?: string | undefined;
  archived?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
};

export type CacheStats = {
  orders: number;
  items: number;
  packages: number;
  pendingDetails: number;
  firstOrderDay: string | null;
  lastOrderDay: string | null;
};

export type CacheRepo = ReturnType<typeof createCacheRepo>;

/**
 * fts5 has its own query syntax, and a user's words are not it: a stray quote
 * or `OR` would be a syntax error or a silent change of meaning. Every token is
 * quoted, and a trailing `*` keeps prefix search working.
 */
export function ftsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((token) => token.replace(/["']/g, "").trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return '""';
  return tokens.map((token) => `"${token}"*`).join(" AND ");
}

export function createCacheRepo(db: Database, now: () => number) {
  const iso = () => new Date(now()).toISOString();

  /** INSERT … ON CONFLICT DO UPDATE over the keys the caller actually set. */
  function upsertOrder(row: Partial<OrderRow>): void {
    const keys = Object.keys(row);
    const values = Object.values(row) as Binding[];
    const assignments = keys.filter((key) => key !== "billno").map((key) => `${key} = excluded.${key}`);
    db.query(
      `INSERT INTO orders (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})
       ON CONFLICT(billno) DO UPDATE SET ${assignments.join(", ")}`,
    ).run(...values);
  }

  function replaceItems(billno: string, rows: ItemRow[]): void {
    db.query("DELETE FROM order_items WHERE billno = ?").run(billno);
    db.query("DELETE FROM order_items_fts WHERE billno = ?").run(billno);
    const insert = db.query(
      `INSERT INTO order_items (id, billno, position, goods_id, goods_sn, sku_code, name, attrs, quantity,
        unit_cents, total_cents, retail_unit_cents, cat_id, store_code, store_name, mall, status_code,
        package_no, tracking_number, returnable, refund_status, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const index = db.query(
      "INSERT INTO order_items_fts (name, attrs, store_name, item_id, billno) VALUES (?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(
        row.id, row.billno, row.position, row.goods_id, row.goods_sn, row.sku_code, row.name, row.attrs,
        row.quantity, row.unit_cents, row.total_cents, row.retail_unit_cents, row.cat_id, row.store_code,
        row.store_name, row.mall, row.status_code, row.package_no, row.tracking_number, row.returnable,
        row.refund_status, row.image_url,
      );
      index.run(row.name ?? "", row.attrs ?? "", row.store_name ?? "", row.id, row.billno);
    }
  }

  function replacePriceLines(billno: string, rows: PriceLineRow[]): void {
    db.query("DELETE FROM order_price_lines WHERE billno = ?").run(billno);
    const insert = db.query(
      "INSERT INTO order_price_lines (billno, position, type, label, cents) VALUES (?, ?, ?, ?, ?)",
    );
    for (const row of rows) insert.run(row.billno, row.position, row.type, row.label, row.cents);
  }

  const itemsOf = (billno: string): ItemRow[] =>
    db.query("SELECT * FROM order_items WHERE billno = ? ORDER BY position").all(billno) as ItemRow[];
  const linesOf = (billno: string): PriceLineRow[] =>
    db.query("SELECT * FROM order_price_lines WHERE billno = ? ORDER BY position").all(billno) as PriceLineRow[];

  return {
    /** A list row: everything it knows, and never less than what is stored. */
    upsertSummary(summary: OrderSummary, rawList: string | null): void {
      inTx(db, () => upsertOrder(summaryRow(summary, rawList, iso())));
    },

    /** A full order: replaces its items, its price lines and its raw payload. */
    upsertDetail(order: Order, rawDetail: string | null, parserVersion: number): void {
      inTx(db, () => {
        upsertOrder(orderRow(order, rawDetail, parserVersion, iso()));
        replaceItems(order.billno, itemRows(order));
        replacePriceLines(order.billno, priceLineRows(order));
      });
    },

    /** Parks an order whose detail will never load, so the queue can move on. */
    markDetailError(billno: string, message: string): void {
      db.query("UPDATE orders SET detail_error = ?, detail_fetched_at = ?, updated_at = ? WHERE billno = ?").run(
        message, iso(), iso(), billno,
      );
    },

    /**
     * Replaces the parcels of one order. The raw tracking page is half a
     * megabyte of HTML and `track_order` is always live, so only the
     * normalised events are kept.
     */
    upsertPackages(billno: string, packages: Package[]): void {
      inTx(db, () => {
        db.query("DELETE FROM packages WHERE billno = ?").run(billno);
        const insert = db.query(
          `INSERT INTO packages (billno, package_no, tracking_number, carrier, track_url, event_count,
            last_event_at, payload_json, tracked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const row of packageRows(billno, packages, iso())) {
          insert.run(
            row.billno, row.package_no, row.tracking_number, row.carrier, row.track_url,
            row.event_count, row.last_event_at, row.payload_json, row.tracked_at,
          );
        }
        db.query("UPDATE orders SET package_count = ?, updated_at = ? WHERE billno = ?").run(
          packages.length, iso(), billno,
        );
      });
    },

    getOrder(billno: string): Order | null {
      const row = db.query("SELECT * FROM orders WHERE billno = ?").get(billno) as OrderRow | null;
      return row ? orderOf(row, itemsOf(billno), linesOf(billno)) : null;
    },

    getSummary(billno: string): OrderSummary | null {
      const row = db.query("SELECT * FROM orders WHERE billno = ?").get(billno) as OrderRow | null;
      return row ? summaryOf(row) : null;
    },

    listOrders(filters: OrderFilters): OrderSummary[] {
      const where = new Where()
        .maybe(filters.status, "status = ?", filters.status)
        .maybe(filters.from, "placed_day >= ?", filters.from)
        .maybe(filters.to, "placed_day <= ?", filters.to)
        .maybe(filters.checkoutId, "checkout_id = ?", filters.checkoutId)
        .maybe(filters.store, "billno IN (SELECT billno FROM order_items WHERE store_name = ?)", filters.store);
      if (filters.archived !== undefined) where.add("archived = ?", filters.archived ? 1 : 0);
      const rows = db
        .query(
          `SELECT * FROM orders ${where.sql()} ORDER BY placed_day DESC, billno DESC LIMIT ? OFFSET ?`,
        )
        .all(...where.values, filters.limit ?? 100, filters.offset ?? 0) as OrderRow[];
      return rows.map(summaryOf);
    },

    countOrders(): number {
      return (db.query("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;
    },

    /** Orders whose detail was never fetched and never failed: the sync queue. */
    countPendingDetails(): number {
      return (
        db
          .query("SELECT COUNT(*) AS n FROM orders WHERE detail_fetched_at IS NULL AND detail_error IS NULL")
          .get() as { n: number }
      ).n;
    },

    nextPendingDetail(): string | null {
      const row = db
        .query(
          `SELECT billno FROM orders WHERE detail_fetched_at IS NULL AND detail_error IS NULL
           ORDER BY placed_day DESC LIMIT 1`,
        )
        .get() as { billno: string } | null;
      return row?.billno ?? null;
    },

    /** Orders whose stored parse is older than the current parser. */
    staleParses(parserVersion: number): string[] {
      const rows = db
        .query(
          `SELECT billno FROM orders WHERE raw_detail IS NOT NULL
             AND (parser_version IS NULL OR parser_version < ?) ORDER BY placed_day DESC`,
        )
        .all(parserVersion) as Array<{ billno: string }>;
      return rows.map((row) => row.billno);
    },

    rawDetail(billno: string): string | null {
      const row = db.query("SELECT raw_detail FROM orders WHERE billno = ?").get(billno) as
        | { raw_detail: string | null }
        | null;
      return row?.raw_detail ?? null;
    },

    rawList(billno: string): string | null {
      const row = db.query("SELECT raw_list FROM orders WHERE billno = ?").get(billno) as
        | { raw_list: string | null }
        | null;
      return row?.raw_list ?? null;
    },

    parserVersionOf(billno: string): number | null {
      const row = db.query("SELECT parser_version FROM orders WHERE billno = ?").get(billno) as
        | { parser_version: number | null }
        | null;
      return row?.parser_version ?? null;
    },

    getPackages(billno: string): Package[] {
      const rows = db
        .query("SELECT * FROM packages WHERE billno = ? ORDER BY package_no")
        .all(billno) as PackageRow[];
      return rows.map(packageOf);
    },

    /** Full-text search over the purchased items; no network, ever. */
    searchItems(query: string, limit = 50): ItemRow[] {
      const match = ftsQuery(query);
      try {
        return db
          .query(
            `SELECT i.* FROM order_items_fts f JOIN order_items i ON i.id = f.item_id
             WHERE order_items_fts MATCH ? ORDER BY rank LIMIT ?`,
          )
          .all(match, limit) as ItemRow[];
      } catch {
        // A query fts5 still refuses is an empty result, not a crash.
        return [];
      }
    },

    getMeta(key: string): string | null {
      const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
      return row?.value ?? null;
    },

    setMeta(key: string, value: string): void {
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
    },

    deleteMeta(key: string): void {
      db.query("DELETE FROM meta WHERE key = ?").run(key);
    },

    stats(): CacheStats {
      const one = <T,>(sql: string): T => db.query(sql).get() as T;
      const counts = one<{ orders: number; items: number; packages: number }>(
        `SELECT (SELECT COUNT(*) FROM orders) AS orders,
                (SELECT COUNT(*) FROM order_items) AS items,
                (SELECT COUNT(*) FROM packages) AS packages`,
      );
      const span = one<{ first: string | null; last: string | null }>(
        "SELECT MIN(placed_day) AS first, MAX(placed_day) AS last FROM orders",
      );
      return {
        ...counts,
        pendingDetails: (
          one<{ n: number }>(
            "SELECT COUNT(*) AS n FROM orders WHERE detail_fetched_at IS NULL AND detail_error IS NULL",
          )
        ).n,
        firstOrderDay: span.first,
        lastOrderDay: span.last,
      };
    },
  };
}
