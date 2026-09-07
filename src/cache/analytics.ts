import type { Database } from "bun:sqlite";
import { Where } from "../core/sqlite.js";
import type { ItemRow } from "./rows.js";

// The analytical half of the cache: what was bought, how often, and where the
// money went. Split out of repo.ts because these are the queries that grow —
// every new question is another GROUP BY — while the storage side is fixed.
//
// One rule lives here, in every query: an order that was never paid or was
// cancelled is not spending.

/** One purchased product, folded across every order that contains it. */
export type ProductRow = {
  goods_id: string | null;
  name: string | null;
  store_name: string | null;
  cat_id: string | null;
  image_url: string | null;
  orders: number;
  quantity: number;
  spent_cents: number;
  min_unit_cents: number;
  max_unit_cents: number;
  first_day: string | null;
  last_day: string | null;
};

/** One line of a product's purchase history, oldest first. */
export type ProductPurchaseRow = ItemRow & { placed_day: string | null; placed_at: string | null; status: string };

export type ProductFilters = {
  store?: string | undefined;
  catId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
};

export type SpendingGroup = "month" | "year" | "store" | "payment" | "breakdown";
export type SpendingRow = { key: string; total_cents: number; orders: number };

export type CacheAnalytics = ReturnType<typeof createCacheAnalytics>;

export function createCacheAnalytics(db: Database) {
  return {
    /** Purchased products, folded by `goods_id`, most spent first. */
    listProducts(filters: ProductFilters): ProductRow[] {
      const where = new Where()
        .maybe(filters.store, "i.store_name = ?", filters.store)
        .maybe(filters.catId, "i.cat_id = ?", filters.catId)
        .maybe(filters.from, "o.placed_day >= ?", filters.from)
        .maybe(filters.to, "o.placed_day <= ?", filters.to)
        .add("o.status NOT IN ('unpaid', 'cancelled')");
      return db
        .query(
          `SELECT i.goods_id AS goods_id,
                  MAX(i.name) AS name,
                  MAX(i.store_name) AS store_name,
                  MAX(i.cat_id) AS cat_id,
                  MAX(i.image_url) AS image_url,
                  COUNT(DISTINCT i.billno) AS orders,
                  SUM(i.quantity) AS quantity,
                  SUM(i.total_cents) AS spent_cents,
                  MIN(i.unit_cents) AS min_unit_cents,
                  MAX(i.unit_cents) AS max_unit_cents,
                  MIN(o.placed_day) AS first_day,
                  MAX(o.placed_day) AS last_day
           FROM order_items i JOIN orders o ON o.billno = i.billno
           ${where.sql()}
           GROUP BY i.goods_id
           ORDER BY spent_cents DESC
           LIMIT ?`,
        )
        .all(...where.values, filters.limit ?? 100) as ProductRow[];
    },

    /** Every purchase of one product, oldest first: the price evolution. */
    productHistory(goodsId: string): ProductPurchaseRow[] {
      return db
        .query(
          `SELECT i.*, o.placed_day AS placed_day, o.placed_at AS placed_at, o.status AS status
           FROM order_items i JOIN orders o ON o.billno = i.billno
           WHERE i.goods_id = ? ORDER BY o.placed_day ASC, i.billno ASC`,
        )
        .all(goodsId) as ProductPurchaseRow[];
    },

    /** Items carrying a refund or return record. */
    listReturns(filters: { from?: string | undefined; to?: string | undefined; limit?: number | undefined }): ProductPurchaseRow[] {
      const where = new Where()
        .add("i.refund_status IS NOT NULL")
        .maybe(filters.from, "o.placed_day >= ?", filters.from)
        .maybe(filters.to, "o.placed_day <= ?", filters.to);
      return db
        .query(
          `SELECT i.*, o.placed_day AS placed_day, o.placed_at AS placed_at, o.status AS status
           FROM order_items i JOIN orders o ON o.billno = i.billno
           ${where.sql()} ORDER BY o.placed_day DESC LIMIT ?`,
        )
        .all(...where.values, filters.limit ?? 100) as ProductPurchaseRow[];
    },

    /** Orders the user may still return something from. */
    countReturnable(): number {
      return (
        db.query("SELECT COUNT(*) AS n FROM orders WHERE returnable = 1").get() as { n: number }
      ).n;
    },

    /**
     * Totals by month, year, store, payment method, or by price-line type.
     * Unpaid and cancelled orders are never counted: they are not spending.
     */
    spendingBy(group: SpendingGroup, filters: { from?: string | undefined; to?: string | undefined }): SpendingRow[] {
      const where = new Where()
        .add("o.status NOT IN ('unpaid', 'cancelled')")
        .maybe(filters.from, "o.placed_day >= ?", filters.from)
        .maybe(filters.to, "o.placed_day <= ?", filters.to);

      if (group === "breakdown") {
        // The rows that add up to the total, folded by type across orders.
        return db
          .query(
            `SELECT p.type AS key, SUM(p.cents) AS total_cents, COUNT(DISTINCT p.billno) AS orders
             FROM order_price_lines p JOIN orders o ON o.billno = p.billno
             ${where.sql()} GROUP BY p.type HAVING total_cents <> 0 ORDER BY total_cents DESC`,
          )
          .all(...where.values) as SpendingRow[];
      }
      if (group === "store") {
        // A store's share is the sum of ITS lines, not of the whole order.
        return db
          .query(
            `SELECT COALESCE(i.store_name, '(sem loja)') AS key, SUM(i.total_cents) AS total_cents,
                    COUNT(DISTINCT i.billno) AS orders
             FROM order_items i JOIN orders o ON o.billno = i.billno
             ${where.sql()} GROUP BY key ORDER BY total_cents DESC`,
          )
          .all(...where.values) as SpendingRow[];
      }
      const key =
        group === "month"
          ? "substr(o.placed_day, 1, 7)"
          : group === "year"
            ? "substr(o.placed_day, 1, 4)"
            : "COALESCE(o.payment_method, '(sem método)')";
      const order = group === "payment" ? "total_cents DESC" : "key DESC";
      return db
        .query(
          `SELECT ${key} AS key, SUM(o.total_cents) AS total_cents, COUNT(*) AS orders
           FROM orders o ${where.sql()} GROUP BY key ORDER BY ${order}`,
        )
        .all(...where.values) as SpendingRow[];
    },

    /** What the grand total of a spending report is measured against. */
    spentTotal(filters: { from?: string | undefined; to?: string | undefined }): { cents: number; orders: number } {
      const where = new Where()
        .add("status NOT IN ('unpaid', 'cancelled')")
        .maybe(filters.from, "placed_day >= ?", filters.from)
        .maybe(filters.to, "placed_day <= ?", filters.to);
      const row = db
        .query(`SELECT COALESCE(SUM(total_cents), 0) AS cents, COUNT(*) AS orders FROM orders ${where.sql()}`)
        .get(...where.values) as { cents: number; orders: number };
      return row;
    },

    /** Flat rows for `export`, joined the way a spreadsheet wants them. */
    exportOrders(): Array<Record<string, unknown>> {
      return db
        .query(
          `SELECT billno, checkout_id, placed_at, paid_at, status, status_label, currency,
                  total_cents, subtotal_cents, saved_cents, shipping_cents, tax_cents,
                  installment_fee_cents, payment_method, payment_title, goods_count, package_count, archived
           FROM orders ORDER BY placed_day DESC, billno DESC`,
        )
        .all() as Array<Record<string, unknown>>;
    },

    exportItems(): Array<Record<string, unknown>> {
      return db
        .query(
          `SELECT i.billno, o.placed_at, o.status, i.goods_id, i.name, i.attrs, i.quantity,
                  i.unit_cents, i.total_cents, i.retail_unit_cents, i.store_name, i.mall,
                  i.package_no, i.tracking_number
           FROM order_items i JOIN orders o ON o.billno = i.billno
           ORDER BY o.placed_day DESC, i.billno DESC, i.position`,
        )
        .all() as Array<Record<string, unknown>>;
    },
  };
}
