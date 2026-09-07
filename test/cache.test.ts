import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS, openCache } from "../src/cache/db.js";
import { type CacheRepo, createCacheRepo } from "../src/cache/repo.js";
import { normalizeOrder, normalizePackages, normalizeSummary } from "../src/domain/normalize.js";
import type { RawOrderDetail, RawOrderListPage, RawTrackSsrData } from "../src/shein/types.js";

// The cache is what makes "how much did I spend" free. Every assertion runs on
// orders normalized from the real (anonymised) captures.

const fixture = <T,>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8")) as T;

const DETAIL = fixture<{ info: RawOrderDetail }>("order-detail").info;
const TAXED = fixture<{ info: RawOrderDetail }>("order-detail-tax").info;
const LIST = fixture<{ info: RawOrderListPage }>("order-list").info;
const ARCHIVE = fixture<{ info: RawOrderListPage }>("order-archive").info;
const TRACK = fixture<RawTrackSsrData>("track");

const summaryOf = (billno: string) => LIST.order_list?.find((order) => order.billno === billno);
const order = () => normalizeOrder({ detail: DETAIL, summary: summaryOf(DETAIL.billno as string) });
const taxedOrder = () => normalizeOrder({ detail: TAXED, summary: summaryOf(TAXED.billno as string) });

let db: Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function repo(): CacheRepo {
  db = openCache(":memory:");
  return createCacheRepo(db, () => 1_757_000_000_000);
}

describe("schema", () => {
  test("migrating twice is a no-op, so every start is safe", () => {
    const cache = repo();
    cache.setMeta("probe", "1");
    // Re-running the migrations must not wipe or duplicate anything.
    for (const migration of MIGRATIONS) (db as Database).exec(migration);
    expect(cache.getMeta("probe")).toBe("1");
  });
});

describe("orders", () => {
  test("stores a summary and reads it back with the money intact", () => {
    const cache = repo();
    const summary = normalizeSummary(LIST.order_list?.[0] as never);
    cache.upsertSummary(summary, JSON.stringify(LIST.order_list?.[0]));
    const stored = cache.getOrder(summary.billno);
    expect(stored?.billno).toBe(summary.billno);
    expect(stored?.money.total).toBe(6998);
    expect(stored?.status).toBe("delivered");
    expect(stored?.checkoutId).toBe(summary.checkoutId);
    // No detail yet: it is queued for the sync.
    expect(cache.countPendingDetails()).toBe(1);
  });

  test("the detail enriches the same row instead of adding another", () => {
    const cache = repo();
    const summary = normalizeSummary(LIST.order_list?.[0] as never);
    cache.upsertSummary(summary, "{}");
    cache.upsertDetail(order(), "{}", 2);
    expect(cache.countOrders()).toBe(1);
    const stored = cache.getOrder(summary.billno);
    expect(stored?.items).toHaveLength(2);
    expect(stored?.priceLines.reduce((sum, line) => sum + line.cents, 0)).toBe(stored?.money.total);
    expect(cache.countPendingDetails()).toBe(0);
  });

  test("storing the same order twice never duplicates its items or price lines", () => {
    const cache = repo();
    cache.upsertDetail(order(), "{}", 2);
    cache.upsertDetail(order(), "{}", 2);
    expect(cache.countOrders()).toBe(1);
    const stored = cache.getOrder(order().billno);
    expect(stored?.items).toHaveLength(2);
    expect(stored?.priceLines).toHaveLength(order().priceLines.length);
  });

  test("keeps the raw payload so a better parser can be re-run offline", () => {
    const cache = repo();
    cache.upsertDetail(order(), JSON.stringify({ hello: "world" }), 2);
    const raw = cache.rawDetail(order().billno);
    expect(JSON.parse(raw as string)).toEqual({ hello: "world" });
    expect(cache.parserVersionOf(order().billno)).toBe(2);
  });

  test("lists newest first and filters the way the tools ask", () => {
    const cache = repo();
    for (const raw of LIST.order_list ?? []) cache.upsertSummary(normalizeSummary(raw), "{}");
    cache.upsertSummary(normalizeSummary(ARCHIVE.order_list?.[0] as never, { archived: true }), "{}");

    const all = cache.listOrders({});
    expect(all.length).toBe((LIST.order_list?.length ?? 0) + 1);
    const days = all.map((row) => row.placedAt ?? "");
    expect([...days].sort().reverse()).toEqual(days);

    expect(cache.listOrders({ status: "delivered" }).length).toBeGreaterThan(0);
    expect(cache.listOrders({ status: "cancelled" })).toHaveLength(0);
    expect(cache.listOrders({ archived: true })).toHaveLength(1);
    const checkout = all[0]?.checkoutId as string;
    expect(cache.listOrders({ checkoutId: checkout }).every((row) => row.checkoutId === checkout)).toBe(true);
    // The window is inclusive on both ends, in Brasília days.
    expect(cache.listOrders({ from: "2026-08-14", to: "2026-08-14" }).length).toBeGreaterThan(0);
    expect(cache.listOrders({ from: "2030-01-01" })).toHaveLength(0);
    expect(cache.listOrders({ limit: 2 })).toHaveLength(2);
  });
});

describe("full text search", () => {
  test("finds a purchased item ignoring accents and case", () => {
    const cache = repo();
    cache.upsertDetail(order(), "{}", 1);
    const name = order().items[0]?.name as string;
    const word = name.split(" ")[0] as string;
    expect(cache.searchItems(word.toLowerCase()).length).toBeGreaterThan(0);
    // remove_diacritics 2 is the whole point for a Brazilian catalogue.
    const accented = word.replace(/a/i, "á").replace(/e/i, "é");
    expect(cache.searchItems(accented).length).toBeGreaterThan(0);
    expect(cache.searchItems("zzzznothing")).toHaveLength(0);
  });

  test("a query with fts operators in it is treated as text, not as syntax", () => {
    const cache = repo();
    cache.upsertDetail(order(), "{}", 1);
    expect(() => cache.searchItems('"unbalanced OR (')).not.toThrow();
  });

  test("re-syncing an order does not leave its old items in the index", () => {
    const cache = repo();
    cache.upsertDetail(order(), "{}", 1);
    const before = cache.searchItems(order().items[0]?.name?.split(" ")[0] as string).length;
    cache.upsertDetail(order(), "{}", 1);
    expect(cache.searchItems(order().items[0]?.name?.split(" ")[0] as string).length).toBe(before);
  });
});

describe("packages", () => {
  test("stores the parcels of an order and reads their events back", () => {
    const cache = repo();
    cache.upsertDetail(order(), "{}", 1);
    const packages = normalizePackages(TRACK);
    cache.upsertPackages(order().billno, packages);
    const stored = cache.getPackages(order().billno);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.carrier).toBe("Imile Brazil");
    expect(stored[0]?.events).toHaveLength(27);
    // Tracking a parcel also corrects the order's package count.
    expect(cache.getOrder(order().billno)?.packageCount).toBe(1);
    // Two orders of one checkout can share a parcel: it is stored per order.
    cache.upsertDetail(taxedOrder(), "{}", 1);
    cache.upsertPackages(taxedOrder().billno, packages);
    expect(cache.getPackages(taxedOrder().billno)).toHaveLength(1);
  });

  test("tracking the same order again replaces the parcel instead of piling up", () => {
    const cache = repo();
    cache.upsertDetail(order(), "{}", 1);
    const packages = normalizePackages(TRACK);
    cache.upsertPackages(order().billno, packages);
    cache.upsertPackages(order().billno, packages);
    expect(cache.getPackages(order().billno)).toHaveLength(1);
  });
});

describe("meta and stats", () => {
  test("round trips the sync cursor and forgets it on demand", () => {
    const cache = repo();
    expect(cache.getMeta("cursor")).toBeNull();
    cache.setMeta("cursor", JSON.stringify({ page: 2 }));
    expect(JSON.parse(cache.getMeta("cursor") as string)).toEqual({ page: 2 });
    cache.deleteMeta("cursor");
    expect(cache.getMeta("cursor")).toBeNull();
  });

  test("counts what the tools report to the user", () => {
    const cache = repo();
    cache.upsertDetail(order(), "{}", 1);
    cache.upsertSummary(normalizeSummary(ARCHIVE.order_list?.[0] as never, { archived: true }), "{}");
    const stats = cache.stats();
    expect(stats.orders).toBe(2);
    expect(stats.items).toBe(2);
    expect(stats.pendingDetails).toBe(1);
  });
});
