import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCache } from "../src/cache/db.js";
import { loadConfig } from "../src/config.js";
import { type Ctx, createContext } from "../src/context.js";
import { runTool } from "../src/tools/define.js";
import { toolByName } from "../src/tools/registry.js";
import type { AuthStatus } from "../src/tools/auth.js";
import { createMemorySessionStore } from "../src/session/store.js";
import {
  type ScriptedFetch,
  SECRET_SESSION,
  bffOk,
  fakeClock,
  htmlResponse,
  jsonResponse,
  redirectResponse,
  response,
  scriptedFetch,
  sessionData,
  silentLogger,
} from "./helpers.js";

const exportDirs: string[] = [];
afterAll(() => {
  for (const dir of exportDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function context(
  script: Parameters<typeof scriptedFetch>[0],
  session: ReturnType<typeof sessionData> | null = sessionData({}, ".acme.test"),
  fallback?: Parameters<typeof scriptedFetch>[1],
): { ctx: Ctx; fetch: ScriptedFetch } {
  const clock = fakeClock();
  const fetch = scriptedFetch(script, fallback);
  const exportDir = mkdtempSync(join(tmpdir(), "shein-export-"));
  exportDirs.push(exportDir);
  const config = loadConfig({
    SHEIN_CONFIG_DIR: "/nonexistent/shein-mcp-test",
    SHEIN_EXPORT_DIR: exportDir,
    SHEIN_BASE_URL: "https://br.acme.test",
    SHEIN_TRANSPORT: "fetch",
    SHEIN_MIN_INTERVAL_MS: "0",
    SHEIN_JITTER_MS: "0",
  });
  const ctx = createContext(config, {
    fetch,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0,
    session: createMemorySessionStore(session),
    log: silentLogger(),
    // In-memory: no tool may create a database in the user's config dir.
    db: openCache(":memory:"),
  });
  return { ctx, fetch };
}

export const call = (name: string, args: Record<string, unknown>, ctx: Ctx) =>
  runTool(toolByName(name) as never, args, ctx);

describe("auth_status", () => {
  test("without a session reports loggedIn:false and never touches the network", async () => {
    const { ctx, fetch } = context([], null);
    const status = (await call("auth_status", {}, ctx)) as AuthStatus;
    expect(status.loggedIn).toBe(false);
    expect(status.hint).toMatch(/shein login/);
    expect(fetch.calls).toHaveLength(0);
  });

  test("reports the session facts without spending a request", async () => {
    const { ctx, fetch } = context([]);
    const status = (await call("auth_status", {}, ctx)) as AuthStatus;
    expect(status).toMatchObject({
      loggedIn: true,
      memberId: "1234567890",
      transport: "fetch",
      breaker: "ok",
      cookieCount: 3,
      httpOnlyCount: 1,
    });
    expect(fetch.calls).toHaveLength(0);
  });

  test("never returns a cookie value", async () => {
    const { ctx } = context([]);
    const status = await call("auth_status", {}, ctx);
    expect(JSON.stringify(status)).not.toContain(SECRET_SESSION);
  });

  test("verify=true spends exactly one request on the first page of the list", async () => {
    const { ctx, fetch } = context([bffOk({ order_list: [{ billno: "X" }], sum: "20" })]);
    const status = (await call("auth_status", { verify: true }, ctx)) as AuthStatus;
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url).toContain("/bff-api/order/list");
    expect(fetch.calls[0]?.url).toContain("limit=1");
    expect(status.verified).toBe(true);
    expect(status.totalOrders).toBe(20);
  });

  test("an expired session is a status, not a thrown error", async () => {
    const { ctx } = context([redirectResponse("https://br.acme.test/user/auth/login")]);
    const status = (await call("auth_status", { verify: true }, ctx)) as AuthStatus;
    expect(status.loggedIn).toBe(false);
    expect(status.verified).toBe(false);
    expect(status.error).toMatch(/shein login/);
  });

  test("the ambiguous 00101001 code is reported as a suspect session, not a crash", async () => {
    const { ctx } = context([jsonResponse({ code: "00101001", msg: "Server error, please try again.", info: {} })]);
    const status = (await call("auth_status", { verify: true }, ctx)) as AuthStatus;
    expect(status.verified).toBe(false);
    expect(status.error).toMatch(/shein login/);
  });

  test("an anti-bot verdict is reported with the tripped breaker", async () => {
    const { ctx } = context([response({ status: 403 })]);
    const status = (await call("auth_status", { verify: true }, ctx)) as AuthStatus;
    expect(status.breaker).toBe("tripped");
    expect(status.verified).toBe(false);
    expect(status.error).toMatch(/anti-bot/);
  });
});

describe("raw_get", () => {
  test("refuses a path outside the order surfaces", async () => {
    const { ctx, fetch } = context([]);
    for (const path of ["/bff-api/user-api/common/userinfo_ugid", "/api/x", "bff-api/order/list", "../etc/passwd"]) {
      await expect(call("raw_get", { path }, ctx)).rejects.toThrow(/fora do escopo/);
    }
    expect(fetch.calls).toHaveLength(0);
  });

  test("refuses every write path even though the cookies would work", async () => {
    const { ctx, fetch } = context([]);
    for (const path of [
      "/bff-api/order-api/order/cancel_return_order",
      "/bff-api/order-api/order/submit_return_info",
      "/bff-api/order/update_order_mark",
      "/bff-api/order-api/order/get_order_return_label",
      "/user/orders/confirm_delivery",
    ]) {
      await expect(call("raw_get", { path }, ctx)).rejects.toThrow(/somente leitura/);
    }
    expect(fetch.calls).toHaveLength(0);
  });

  test("passes a read path through with the extra query and reports the envelope", async () => {
    const { ctx, fetch } = context([bffOk({ sum: 3 })]);
    const result = (await call("raw_get", { path: "/bff-api/order/list", query: { page: 2, limit: 5 } }, ctx)) as {
      code: string;
      truncated: boolean;
      data: { info: { sum: number } };
    };
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url).toContain("page=2");
    expect(fetch.calls[0]?.url).toContain("_ver=");
    expect(result.code).toBe("0");
    expect(result.truncated).toBe(false);
    expect(result.data.info.sum).toBe(3);
  });

  test("reads an html surface as text when asked", async () => {
    const { ctx, fetch } = context([htmlResponse("<html>var gbRawData = {}</html>")]);
    const result = (await call("raw_get", { path: "/user/orders/list", kind: "html" }, ctx)) as { data: string };
    expect(fetch.calls[0]?.init.headers.accept).toContain("text/html");
    expect(result.data).toContain("gbRawData");
  });

  test("truncates a big payload instead of flooding the context", async () => {
    const { ctx } = context([bffOk({ blob: "x".repeat(5000) })]);
    const result = (await call("raw_get", { path: "/bff-api/order/list", max_bytes: 1024 }, ctx)) as {
      truncated: boolean;
      data: unknown;
      bytes: number;
    };
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeGreaterThan(1024);
    expect(String(result.data)).toHaveLength(1025);
  });
});

describe("sync", () => {
  test("reports what it stored and that there is nothing left to do", async () => {
    const list = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures", "order-list.json"), "utf8"),
    ) as { info: { order_list: Array<Record<string, unknown>> } };
    const detail = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures", "order-detail.json"), "utf8"),
    ) as { info: Record<string, unknown> };
    const { ctx, fetch } = context(
      [bffOk({ ...list.info, sum: list.info.order_list.length }), bffOk({ order_list: [], sum: 0 })],
      undefined,
      (url: string) => bffOk({ ...detail.info, billno: new URL(url).searchParams.get("billno") }),
    );
    const result = (await call("sync", { mode: "full" }, ctx)) as {
      done: boolean;
      listed: number;
      cache: { orders: number; spentTotal: number };
      hint: string;
    };
    expect(result.done).toBe(true);
    expect(result.listed).toBe(list.info.order_list.length);
    expect(result.cache.orders).toBe(list.info.order_list.length);
    expect(result.cache.spentTotal).toBeGreaterThan(0);
    expect(result.hint).toMatch(/conclu/i);
    expect(fetch.calls.length).toBeGreaterThan(list.info.order_list.length);
  });

  test("is absent in read-only mode: it writes to the cache", () => {
    expect(toolByName("sync")?.readOnly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The cache-backed tools. They run against a database seeded through the real
// sync from the real (anonymised) fixtures, so the assertions are about real
// data shapes — and about how many requests each tool is allowed to spend.

const LIST_FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "order-list.json"), "utf8"),
) as { info: { order_list: Array<Record<string, unknown>> } };
const DETAIL_FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "order-detail.json"), "utf8"),
) as { info: Record<string, unknown> };
const TRACK_FIXTURE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "track.json"), "utf8")) as unknown;
const FIRST_BILLNO = LIST_FIXTURE.info.order_list[0]?.billno as string;

/**
 * A cache filled through the real sync. The fallback answers by URL, so a test
 * can ask for anything afterwards without counting script entries.
 */
async function seeded(options: { track?: unknown } = {}) {
  const track = options.track ?? TRACK_FIXTURE;
  const { ctx, fetch } = context(
    [
      bffOk({ ...LIST_FIXTURE.info, sum: LIST_FIXTURE.info.order_list.length }),
      bffOk({ order_list: [], sum: 0 }),
    ],
    undefined,
    (url: string) => {
      if (url.includes("/orders/track")) {
        return htmlResponse(`<html><script>var gbOrdersTrackSsrData = ${JSON.stringify(track)}</script></html>`);
      }
      if (url.includes("get_order_archive_list")) return bffOk({ order_list: [], sum: 0 });
      if (url.includes("/order/list")) return bffOk({ ...LIST_FIXTURE.info, sum: LIST_FIXTURE.info.order_list.length });
      return bffOk({ ...DETAIL_FIXTURE.info, billno: new URL(url).searchParams.get("billno") });
    },
  );
  await call("sync", { mode: "full" }, ctx);
  return { ctx, fetch };
}

describe("list_orders", () => {
  test("answers from the cache with no network at all", async () => {
    const { ctx, fetch } = await seeded();
    const before = fetch.calls.length;
    const result = (await call("list_orders", {}, ctx)) as {
      total: number;
      returned: number;
      orders: Array<{ billno: string; total: number; currency: string; status: string }>;
    };
    expect(fetch.calls.length).toBe(before);
    expect(result.total).toBe(LIST_FIXTURE.info.order_list.length);
    expect(result.orders[0]?.total).toBe(69.98);
    expect(result.orders[0]?.currency).toBe("BRL");
    expect(result.orders[0]?.status).toBe("delivered");
  });

  test("filters and paginates the way the description promises", async () => {
    const { ctx } = await seeded();
    expect(((await call("list_orders", { status: "cancelled" }, ctx)) as { returned: number }).returned).toBe(0);
    expect(((await call("list_orders", { limit: 1 }, ctx)) as { returned: number }).returned).toBe(1);
    const byDay = (await call("list_orders", { from: "2030-01-01" }, ctx)) as { returned: number };
    expect(byDay.returned).toBe(0);
  });

  test("compact drops the fields a model rarely needs", async () => {
    const { ctx } = await seeded();
    const full = (await call("list_orders", { limit: 1 }, ctx)) as { orders: Array<Record<string, unknown>> };
    const compact = (await call("list_orders", { limit: 1, compact: true }, ctx)) as {
      orders: Array<Record<string, unknown>>;
    };
    expect(full.orders[0]).toHaveProperty("malls");
    expect(compact.orders[0]).not.toHaveProperty("malls");
    expect(compact.orders[0]).toHaveProperty("total");
  });

  test("tells the model to sync when the cache is empty", async () => {
    const { ctx } = context([]);
    const result = (await call("list_orders", {}, ctx)) as { total: number; note?: string };
    expect(result.total).toBe(0);
    expect(result.note).toMatch(/sync/);
  });
});

describe("get_order", () => {
  test("reads from the cache without spending a request", async () => {
    const { ctx, fetch } = await seeded();
    const before = fetch.calls.length;
    const order = (await call("get_order", { billno: FIRST_BILLNO }, ctx)) as {
      source: string;
      total: number;
      priceLines: Array<{ type: string; amount: number }>;
      items: Array<{ name: string; unitPrice: number }>;
      installments: null;
      address?: unknown;
    };
    expect(fetch.calls.length).toBe(before);
    expect(order.source).toBe("cache");
    expect(order.total).toBe(69.98);
    // The breakdown still adds up once it is decimals for the caller.
    const sum = order.priceLines.reduce((total, line) => total + line.amount, 0);
    expect(Math.round(sum * 100)).toBe(Math.round(order.total * 100));
    expect(order.items[0]?.unitPrice).toBe(34.99);
    expect(order.installments).toBeNull();
    // The address is private: absent unless asked for.
    expect(order.address).toBeUndefined();
  });

  test("returns the address only when asked", async () => {
    const { ctx } = await seeded();
    const order = (await call("get_order", { billno: FIRST_BILLNO, include_address: true }, ctx)) as {
      address: { city: string } | null;
    };
    expect(order.address?.city).toBe("Cidade Exemplo");
  });

  test("fetches once for an order the cache never saw, then serves it from cache", async () => {
    const { ctx, fetch } = await seeded();
    const before = fetch.calls.length;
    const first = (await call("get_order", { billno: "GSH000000000000" }, ctx)) as { source: string };
    expect(first.source).toBe("live");
    expect(fetch.calls.length).toBe(before + 1);
    const second = (await call("get_order", { billno: "GSH000000000000" }, ctx)) as { source: string };
    expect(second.source).toBe("cache");
    expect(fetch.calls.length).toBe(before + 1);
  });
});

describe("track_order", () => {
  test("always goes to the network and caches what it got", async () => {
    const { ctx, fetch } = await seeded();
    const before = fetch.calls.length;
    const result = (await call("track_order", { billno: FIRST_BILLNO }, ctx)) as {
      packageCount: number;
      packages: Array<{ carrier: string; events: Array<{ description: string }> }>;
    };
    expect(fetch.calls.length).toBe(before + 1);
    expect(result.packageCount).toBe(1);
    expect(result.packages[0]?.carrier).toBe("Imile Brazil");
    expect(result.packages[0]?.events.length).toBeGreaterThan(0);
    expect(ctx.cache().getPackages(FIRST_BILLNO)).toHaveLength(1);
  });

  test("an order that never shipped reports no parcels, not an error", async () => {
    const { ctx } = await seeded({ track: { packageMap: { "0": {} } } });
    const result = (await call("track_order", { billno: FIRST_BILLNO }, ctx)) as {
      packageCount: number;
      note?: string;
    };
    expect(result.packageCount).toBe(0);
    expect(result.note).toMatch(/enviad|rastre/i);
  });
});

describe("search_products", () => {
  test("finds a purchased item without accents and without the network", async () => {
    const { ctx, fetch } = await seeded();
    const before = fetch.calls.length;
    const name = (DETAIL_FIXTURE.info.orderGoodsList as Array<{ product: { goods_name: string } }>)[0]
      ?.product.goods_name as string;
    const word = name.split(" ")[0] as string;
    const result = (await call("search_products", { query: word.toLowerCase() }, ctx)) as {
      total: number;
      items: Array<{ name: string; unitPrice: number; billno: string }>;
    };
    expect(fetch.calls.length).toBe(before);
    expect(result.total).toBeGreaterThan(0);
    expect(result.items[0]?.name).toBe(name);
    expect(result.items[0]?.unitPrice).toBe(34.99);
  });

  test("an empty cache says to sync instead of answering nothing", async () => {
    const { ctx } = context([]);
    const result = (await call("search_products", { query: "conjunto" }, ctx)) as { total: number; note?: string };
    expect(result.total).toBe(0);
    expect(result.note).toMatch(/sync/);
  });
});

describe("list_products", () => {
  test("folds the same product across orders, biggest spend first", async () => {
    const { ctx, fetch } = await seeded();
    const before = fetch.calls.length;
    const result = (await call("list_products", {}, ctx)) as {
      total: number;
      products: Array<{ goodsId: string; orders: number; quantity: number; spent: number; minUnitPrice: number }>;
    };
    expect(fetch.calls.length).toBe(before);
    expect(result.total).toBeGreaterThan(0);
    // Every order in the fixture carries the same two items, so each product
    // was bought in as many orders as there are orders.
    expect(result.products[0]?.orders).toBe(LIST_FIXTURE.info.order_list.length);
    expect(result.products[0]?.quantity).toBe(LIST_FIXTURE.info.order_list.length);
    const spends = result.products.map((product) => product.spent);
    expect([...spends].sort((a, b) => b - a)).toEqual(spends);
    // Spent is the sum of the line totals, in decimals.
    expect(result.products[0]?.spent).toBeCloseTo(34.99 * LIST_FIXTURE.info.order_list.length, 2);
  });

  test("filters by store and by period", async () => {
    const { ctx } = await seeded();
    const store = ((await call("list_products", {}, ctx)) as { products: Array<{ store: string }> }).products[0]
      ?.store as string;
    expect(((await call("list_products", { store }, ctx)) as { total: number }).total).toBeGreaterThan(0);
    expect(((await call("list_products", { store: "Loja Que Nao Existe" }, ctx)) as { total: number }).total).toBe(0);
    expect(((await call("list_products", { from: "2030-01-01" }, ctx)) as { total: number }).total).toBe(0);
  });
});

describe("product_history", () => {
  test("lists every purchase of a product, oldest first, with the price evolution", async () => {
    const { ctx } = await seeded();
    const goodsId = ((await call("list_products", {}, ctx)) as { products: Array<{ goodsId: string }> })
      .products[0]?.goodsId as string;
    const result = (await call("product_history", { product: goodsId }, ctx)) as {
      goodsId: string;
      timesBought: number;
      unitsBought: number;
      spent: number;
      firstUnitPrice: number;
      lastUnitPrice: number;
      purchases: Array<{ placedAt: string; unitPrice: number }>;
    };
    expect(result.goodsId).toBe(goodsId);
    expect(result.timesBought).toBe(LIST_FIXTURE.info.order_list.length);
    expect(result.unitsBought).toBe(LIST_FIXTURE.info.order_list.length);
    expect(result.firstUnitPrice).toBe(34.99);
    expect(result.lastUnitPrice).toBe(34.99);
    const dates = result.purchases.map((purchase) => purchase.placedAt);
    expect([...dates].sort()).toEqual(dates);
  });

  test("resolves a product by name when the caller does not know the id", async () => {
    const { ctx } = await seeded();
    const name = (DETAIL_FIXTURE.info.orderGoodsList as Array<{ product: { goods_name: string } }>)[0]
      ?.product.goods_name as string;
    const result = (await call("product_history", { product: name.split(" ")[0] as string }, ctx)) as {
      goodsId: string | null;
      total: number;
    };
    expect(result.goodsId).toBeTruthy();
    expect(result.total).toBeGreaterThan(0);
  });

  test("says so when nothing matches instead of inventing a product", async () => {
    const { ctx } = await seeded();
    const result = (await call("product_history", { product: "zzzznaoexiste" }, ctx)) as {
      total: number;
      note?: string;
    };
    expect(result.total).toBe(0);
    expect(result.note).toMatch(/Nenhum produto/);
  });
});

describe("list_returns", () => {
  test("reports honestly that nothing is recorded, and how many orders still accept one", async () => {
    const { ctx, fetch } = await seeded();
    const before = fetch.calls.length;
    const result = (await call("list_returns", {}, ctx)) as {
      total: number;
      returnableOrders: number;
      note?: string;
    };
    expect(fetch.calls.length).toBe(before);
    expect(result.total).toBe(0);
    expect(result.returnableOrders).toBeGreaterThan(0);
    // The note must not let a model conclude "the user never returned anything".
    expect(result.note).toMatch(/não mapeou|nao mapeou/i);
  });

  test("lists an item once the order detail carries a refund record", async () => {
    const { ctx } = await seeded();
    const order = ctx.cache().getOrder(FIRST_BILLNO);
    const refunded = {
      ...(order as NonNullable<typeof order>),
      items: [{ ...(order as NonNullable<typeof order>).items[0]!, refundStatus: "refund_pending" }],
    };
    ctx.cache().upsertDetail(refunded, "{}", 1);
    const result = (await call("list_returns", {}, ctx)) as {
      total: number;
      returns: Array<{ billno: string; refundStatus: string }>;
    };
    expect(result.total).toBe(1);
    expect(result.returns[0]?.billno).toBe(FIRST_BILLNO);
    expect(result.returns[0]?.refundStatus).toBe("refund_pending");
  });
});

describe("spending_summary", () => {
  test("groups by month and the rows add up to the grand total", async () => {
    const { ctx, fetch } = await seeded();
    const before = fetch.calls.length;
    const result = (await call("spending_summary", { group_by: "month" }, ctx)) as {
      rows: Array<{ key: string; total: number; orders: number }>;
      grandTotal: number;
      currency: string;
      note: string;
    };
    expect(fetch.calls.length).toBe(before);
    const sum = result.rows.reduce((total, row) => total + row.total, 0);
    expect(Math.round(sum * 100)).toBe(Math.round(result.grandTotal * 100));
    expect(result.rows[0]?.key).toMatch(/^\d{4}-\d{2}$/);
    expect(result.currency).toBe("BRL");
    expect(result.note).toBeTruthy();
  });

  test("leaves unpaid and cancelled orders out of the total", async () => {
    const { ctx } = await seeded();
    const paid = (await call("spending_summary", { group_by: "year" }, ctx)) as { grandTotal: number };
    const order = ctx.cache().getOrder(FIRST_BILLNO);
    ctx.cache().upsertDetail({ ...(order as NonNullable<typeof order>), status: "unpaid" }, "{}", 1);
    const after = (await call("spending_summary", { group_by: "year" }, ctx)) as { grandTotal: number };
    expect(after.grandTotal).toBeLessThan(paid.grandTotal);
  });

  test("breakdown says where the money went, using the rows that add up", async () => {
    const { ctx } = await seeded();
    const result = (await call("spending_summary", { group_by: "breakdown" }, ctx)) as {
      rows: Array<{ key: string; total: number }>;
      grandTotal: number;
    };
    expect(result.rows.map((row) => row.key)).toContain("newSubTotal");
    const sum = result.rows.reduce((total, row) => total + row.total, 0);
    expect(Math.round(sum * 100)).toBe(Math.round(result.grandTotal * 100));
  });

  test("groups by store and by payment method too", async () => {
    const { ctx } = await seeded();
    for (const group of ["store", "payment"] as const) {
      const result = (await call("spending_summary", { group_by: group }, ctx)) as {
        rows: Array<{ key: string; total: number }>;
      };
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows[0]?.total).toBeGreaterThan(0);
    }
  });
});

describe("export", () => {
  test("writes inside the export dir and reports the path", async () => {
    const { ctx } = await seeded();
    const result = (await call("export", { format: "csv", scope: "orders" }, ctx)) as {
      path: string;
      rows: number;
    };
    expect(result.path.startsWith(ctx.config.exportDir)).toBe(true);
    expect(result.rows).toBe(LIST_FIXTURE.info.order_list.length);
    const csv = readFileSync(result.path, "utf8");
    expect(csv.split("\n")[0]).toContain("billno");
    // Money is written as decimals, so a spreadsheet reads it as money.
    expect(csv).toContain("69.98");
  });

  test("a filename cannot escape the export dir", async () => {
    const { ctx } = await seeded();
    for (const filename of ["../escape.csv", "/etc/passwd", "..%2Fx", "sub/dir.csv"]) {
      const result = (await call("export", { format: "csv", scope: "orders", filename }, ctx)) as { path: string };
      expect(result.path.startsWith(`${ctx.config.exportDir}/`)).toBe(true);
      expect(result.path).not.toContain("..");
    }
  });

  test("exports the items too, as json when asked", async () => {
    const { ctx } = await seeded();
    const result = (await call("export", { format: "json", scope: "items" }, ctx)) as { path: string; rows: number };
    const parsed = JSON.parse(readFileSync(result.path, "utf8")) as Array<{ name: string }>;
    expect(parsed).toHaveLength(result.rows);
    expect(parsed[0]?.name).toBeTruthy();
  });
});

describe("doctor", () => {
  test("without a session it reports every layer as skipped and spends nothing", async () => {
    const { ctx, fetch } = context([], null);
    const report = (await call("doctor", {}, ctx)) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; detail: string }>;
      hint?: string;
    };
    expect(fetch.calls).toHaveLength(0);
    expect(report.ok).toBe(false);
    expect(report.checks.map((check) => check.name)).toEqual([
      "session",
      "order_list",
      "order_archive",
      "order_detail",
      "order_track",
      "cache",
    ]);
    expect(report.checks[1]?.detail).toMatch(/sess/i);
    expect(report.hint).toMatch(/shein login/);
  });

  test("with a working session every layer passes and the cache is described", async () => {
    const { ctx } = await seeded();
    const report = (await call("doctor", {}, ctx)) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; detail: string }>;
    };
    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.ok)).toBe(true);
    expect(report.checks.find((check) => check.name === "cache")?.detail).toMatch(/pedido/);
  });

  test("a broken layer is named, and the ones after it still run", async () => {
    const { ctx } = await seeded();
    // The detail endpoint starts answering garbage; every other layer is fine.
    const broken = context([], undefined, (url: string) => {
      if (url.includes("get_order_detail")) return htmlResponse("<html>oops</html>");
      if (url.includes("/orders/track")) {
        return htmlResponse(`<html><script>var gbOrdersTrackSsrData = ${JSON.stringify(TRACK_FIXTURE)}</script></html>`);
      }
      if (url.includes("get_order_archive_list")) return bffOk({ order_list: [], sum: 0 });
      return bffOk({ ...LIST_FIXTURE.info, sum: LIST_FIXTURE.info.order_list.length });
    });
    const report = (await call("doctor", {}, broken.ctx)) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean }>;
    };
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "order_detail")?.ok).toBe(false);
    // The layers before and after it still ran and still report their own state.
    expect(report.checks.find((check) => check.name === "order_list")?.ok).toBe(true);
    expect(report.checks.find((check) => check.name === "order_track")?.ok).toBe(true);
    expect(report.checks.find((check) => check.name === "cache")?.ok).toBe(true);
    void ctx;
  });
});
