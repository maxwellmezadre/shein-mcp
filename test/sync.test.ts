import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openCache } from "../src/cache/db.js";
import { META, PARSER_VERSION, runSyncChunk } from "../src/cache/sync.js";
import { loadConfig } from "../src/config.js";
import { type Ctx, createContext } from "../src/context.js";
import { SheinAuthError } from "../src/core/errors.js";
import { createMemorySessionStore } from "../src/session/store.js";
import type { RawOrderDetail, RawOrderListItem, RawOrderListPage, RawTrackSsrData } from "../src/shein/types.js";
import { type ScriptedFetch, bffOk, fakeClock, htmlResponse, jsonResponse, redirectResponse, scriptedFetch, sessionData, silentLogger } from "./helpers.js";

// The sync is chunked and resumable because a full history is dozens of paced
// requests: the MCP client must be able to stop after N and call again.

const fixture = <T,>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8")) as T;

const LIST = fixture<{ info: RawOrderListPage }>("order-list").info;
const ARCHIVE = fixture<{ info: RawOrderListPage }>("order-archive").info;
const DETAIL = fixture<{ info: RawOrderDetail }>("order-detail").info;
const TRACK = fixture<RawTrackSsrData>("track");
const ORDERS = LIST.order_list as RawOrderListItem[];

/** A list page carrying `orders`, and a `sum` the walker paginates against. */
const listPage = (orders: RawOrderListItem[], sum = ORDERS.length) => bffOk({ ...LIST, order_list: orders, sum });
const ARCHIVED_DETAIL = fixture<{ info: RawOrderDetail }>("order-detail-archived").info;
const ARCHIVED_BILLNO = ARCHIVE.order_list?.[0]?.billno as string;

/**
 * The detail of whichever order was asked for, so any walk order works. An
 * archived billno gets the empty shell the site really answers with.
 */
const detailFor = (url: string) => {
  const billno = new URL(url).searchParams.get("billno") as string;
  if (billno === ARCHIVED_BILLNO) return bffOk({ ...ARCHIVED_DETAIL, billno });
  return bffOk({ ...DETAIL, billno });
};
const trackPage = () =>
  htmlResponse(`<html><script>var gbOrdersTrackSsrData = ${JSON.stringify(TRACK)}</script></html>`);

let db: Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function context(script: Parameters<typeof scriptedFetch>[0], fallback?: Parameters<typeof scriptedFetch>[1]): { ctx: Ctx; fetch: ScriptedFetch } {
  const clock = fakeClock();
  const fetch = scriptedFetch(script, fallback);
  db = openCache(":memory:");
  const ctx = createContext(
    loadConfig({
      SHEIN_CONFIG_DIR: "/nonexistent/shein-mcp-test",
      SHEIN_BASE_URL: "https://br.acme.test",
      SHEIN_TRANSPORT: "fetch",
      SHEIN_MIN_INTERVAL_MS: "0",
      SHEIN_JITTER_MS: "0",
    }),
    { fetch, sleep: clock.sleep, now: clock.now, random: () => 0, session: createMemorySessionStore(sessionData({}, ".acme.test")), log: silentLogger(), db },
  );
  return { ctx, fetch };
}

describe("full sync", () => {
  test("walks the list, then the archive, then every missing detail", async () => {
    const { ctx, fetch } = context([
      listPage(ORDERS),
      bffOk({ ...ARCHIVE, order_list: ARCHIVE.order_list, sum: 1 }),
      ...ORDERS.map(() => detailFor),
      detailFor,
    ]);
    const result = await runSyncChunk(ctx, { mode: "full" });
    expect(result.done).toBe(true);
    expect(result.listed).toBe(ORDERS.length + 1);
    expect(result.details).toBe(ORDERS.length + 1);
    expect(ctx.cache().countOrders()).toBe(ORDERS.length + 1);
    expect(ctx.cache().countPendingDetails()).toBe(0);
    // The archived order is flagged as such, and keeps the money from its row.
    const archived = ctx.cache().getOrder(ARCHIVE.order_list?.[0]?.billno as string);
    expect(archived?.archived).toBe(true);
    expect(archived?.money.total).toBe(2699);
    expect(ctx.cache().getMeta(META.lastFullSync)).not.toBeNull();
    expect(fetch.calls[0]?.url).toContain("limit=20");
  });

  test("keeps paginating while the account has more orders than one page", async () => {
    const [first, ...rest] = ORDERS;
    const { ctx, fetch } = context(
      [listPage([first as RawOrderListItem], 3), listPage(rest, 3), bffOk({ order_list: [], sum: 0 })],
      detailFor,
    );
    const result = await runSyncChunk(ctx, { mode: "full" });
    expect(result.done).toBe(true);
    expect(ctx.cache().countOrders()).toBe(ORDERS.length);
    expect(new URL(fetch.calls[1]?.url as string).searchParams.get("page")).toBe("2");
  });
});

describe("budget and resume", () => {
  test("stops at max_requests, says so, and continues where it left off", async () => {
    const { ctx, fetch } = context([listPage(ORDERS), bffOk({ order_list: [], sum: 0 }), detailFor], detailFor);
    const first = await runSyncChunk(ctx, { mode: "full", maxRequests: 3 });
    expect(first.done).toBe(false);
    expect(first.requests).toBe(3);
    expect(first.hint).toMatch(/sync/i);
    expect(ctx.cache().countPendingDetails()).toBeGreaterThan(0);

    const calls = fetch.calls.length;
    const second = await runSyncChunk(ctx, { mode: "full" });
    expect(second.done).toBe(true);
    expect(fetch.calls.length).toBeGreaterThan(calls);
    expect(ctx.cache().countPendingDetails()).toBe(0);
    // The cursor is cleared once there is nothing left to do.
    expect(ctx.cache().getMeta(META.cursor)).toBeNull();
  });
});

describe("incremental", () => {
  test("stops at the first full page with nothing new", async () => {
    const { ctx } = context([listPage(ORDERS), bffOk({ order_list: [], sum: 0 })], detailFor);
    await runSyncChunk(ctx, { mode: "full" });

    // Everything is known now: one list page is enough to prove it.
    const { ctx: second, fetch } = context([listPage(ORDERS)], detailFor);
    for (const order of ORDERS) {
      const summary = ctx.cache().getSummary(order.billno as string);
      if (summary) second.cache().upsertSummary(summary, null);
    }
    const result = await runSyncChunk(second, { mode: "incremental" });
    expect(result.done).toBe(true);
    expect(result.listed).toBe(0);
    // One list page proved it, and the archive was not walked at all: it only
    // holds orders older than the ones already known.
    expect(fetch.calls.filter((call) => call.url.includes("/order/list"))).toHaveLength(1);
    expect(fetch.calls.some((call) => call.url.includes("archive"))).toBe(false);
  });
});

describe("reparse", () => {
  test("re-reads the stored payloads with no network at all", async () => {
    const { ctx } = context([listPage(ORDERS), bffOk({ order_list: [], sum: 0 })], detailFor);
    await runSyncChunk(ctx, { mode: "full" });

    const { ctx: offline, fetch } = context([]);
    // Move the stored orders into the offline cache, payloads and all.
    for (const summary of ctx.cache().listOrders({})) {
      const raw = ctx.cache().rawDetail(summary.billno);
      offline.cache().upsertSummary(summary, ctx.cache().rawList(summary.billno));
      if (raw) offline.cache().upsertDetail(ctx.cache().getOrder(summary.billno) as never, raw, PARSER_VERSION - 1);
    }
    const result = await runSyncChunk(offline, { mode: "reparse" });
    expect(fetch.calls).toHaveLength(0);
    expect(result.reparsed).toBeGreaterThan(0);
    expect(result.done).toBe(true);
    expect(offline.cache().parserVersionOf(ORDERS[0]?.billno as string)).toBe(PARSER_VERSION);
  });

  test("a parser upgrade is picked up by the next ordinary sync", async () => {
    const { ctx } = context([listPage(ORDERS), bffOk({ order_list: [], sum: 0 })], detailFor);
    await runSyncChunk(ctx, { mode: "full" });
    ctx.cache().setMeta(META.parserVersion, String(PARSER_VERSION - 1));
    const stale = ctx.cache().staleParses(PARSER_VERSION);
    expect(stale.length).toBe(0); // rows are current; only the marker is old

    const result = await runSyncChunk(ctx, { mode: "incremental" });
    expect(ctx.cache().getMeta(META.parserVersion)).toBe(String(PARSER_VERSION));
    expect(result.done).toBe(true);
  });
});

describe("resilience", () => {
  test("an order whose detail will never load is parked, and the sync moves on", async () => {
    const { ctx } = context(
      [
        listPage(ORDERS),
        bffOk({ order_list: [], sum: 0 }),
        jsonResponse({ code: "100102", msg: "Erro ao solicitar o parâmetro.", info: null }),
      ],
      detailFor,
    );
    const result = await runSyncChunk(ctx, { mode: "full" });
    expect(result.errors).toBe(1);
    expect(result.done).toBe(true);
    expect(ctx.cache().countPendingDetails()).toBe(0);
  });

  test("a dead session stops the sync but keeps everything already stored", async () => {
    const { ctx } = context(
      [listPage(ORDERS), bffOk({ order_list: [], sum: 0 }), redirectResponse("https://br.acme.test/user/auth/login")],
      detailFor,
    );
    await expect(runSyncChunk(ctx, { mode: "full" })).rejects.toThrow(SheinAuthError);
    // Whatever was already listed is committed: a chunk never loses work.
    expect(ctx.cache().countOrders()).toBe(ORDERS.length);
  });
});

describe("tracking", () => {
  test("with_tracking fetches the parcels of the orders that shipped", async () => {
    const { ctx } = context([listPage(ORDERS), bffOk({ order_list: [], sum: 0 })], detailFor);
    await runSyncChunk(ctx, { mode: "full" });

    const { ctx: tracked } = context([trackPage()], trackPage());
    for (const summary of ctx.cache().listOrders({})) {
      tracked.cache().upsertDetail(ctx.cache().getOrder(summary.billno) as never, "{}", PARSER_VERSION);
    }
    const result = await runSyncChunk(tracked, { mode: "incremental", withTracking: true, listPages: 0 });
    expect(result.tracked).toBeGreaterThan(0);
    const packages = tracked.cache().getPackages(ORDERS[0]?.billno as string);
    expect(packages[0]?.events.length).toBeGreaterThan(0);
  });
});
