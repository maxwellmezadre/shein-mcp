#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createContext } from "../src/context.js";
import { createHttp } from "../src/core/http.js";
import { createMemorySessionStore } from "../src/session/store.js";
import { API_VER, ENDPOINTS, STATUS_TYPE_ALL } from "../src/shein/api.js";
import type { RawOrderListItem, RawOrderListPage } from "../src/shein/types.js";

// Captures RAW responses from the real account into task/captures/ (gitignored).
// They become the golden corpus for test/local and, after
// scripts/anonymize-fixture.ts, the committed fixtures. Every capture records
// which transport served it, so "the plain-HTTP replay works" is observable:
// run it with SHEIN_TRANSPORT=fetch for the proof.
//
// Dry-run by default: nothing is written until --write. Read the summary first.
//
// Usage: SHEIN_TRANSPORT=fetch bun run scripts/capture-fixtures.ts [--write] [--max-orders N] [--max-pages N]

const OUT_DIR = join(import.meta.dir, "..", "task", "captures");
const PAGE_LIMIT = 10;

type Capture = {
  name: string;
  path: string;
  ok: boolean;
  status: number | null;
  code: string | null;
  bytes: number;
  transport: string;
  body: string;
};

function flag(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const maxOrders = flag("--max-orders", 30);
  const maxPages = flag("--max-pages", 10);
  const ctx = createContext(loadConfig());
  const { config } = ctx;
  const captures: Capture[] = [];
  const common = { _ver: API_VER, _lang: config.lang };

  const record = (
    name: string,
    path: string,
    outcome: { ok: boolean; status: number | null; code: string | null; body: string },
  ): void => {
    captures.push({ name, path, ...outcome, bytes: outcome.body.length, transport: ctx.http.state().transport });
    const tag = outcome.ok ? "ok " : "ERR";
    console.error(`  ${tag} ${name.padEnd(28)} ${String(outcome.status ?? "-").padEnd(4)} ${outcome.code ?? "-"} ${outcome.body.length} bytes`);
  };

  const url = (path: string, query: Record<string, string | number>): string => {
    const target = new URL(path, `${config.baseUrl}/`);
    for (const [key, value] of Object.entries(query)) target.searchParams.set(key, String(value));
    return target.toString();
  };

  /** One GET through the real client (pacing, breaker, cookies), recorded whatever happens. */
  const capture = async (
    name: string,
    path: string,
    query: Record<string, string | number>,
    kind: "json" | "html" = "json",
  ): Promise<string | null> => {
    try {
      const response = await ctx.http.serial(() =>
        ctx.http.send({ url: url(path, kind === "json" ? { ...common, ...query } : query), method: "GET", kind, label: name }),
      );
      const code = kind === "json" ? codeOf(response.body) : null;
      record(name, path, { ok: kind === "json" ? code === "0" : response.body.includes("var gb"), status: response.status, code, body: response.body });
      return response.body;
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      record(name, path, { ok: false, status: null, code: null, body: JSON.stringify({ error: message }) });
      return null;
    }
  };

  const capturePost = async (name: string, path: string, body: unknown): Promise<void> => {
    try {
      const response = await ctx.http.serial(() =>
        ctx.http.send({
          url: url(path, common),
          method: "POST",
          kind: "json",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          label: name,
        }),
      );
      record(name, path, { ok: codeOf(response.body) === "0", status: response.status, code: codeOf(response.body), body: response.body });
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      record(name, path, { ok: false, status: null, code: null, body: JSON.stringify({ error: message }) });
    }
  };

  console.error(`Capturando com SHEIN_TRANSPORT=${config.transport} (uma requisição por vez, no ritmo normal do cliente)…`);

  // 1. The order list, page by page, until `sum` is covered.
  const orders: RawOrderListItem[] = [];
  let sum = Number.POSITIVE_INFINITY;
  for (let page = 1; page <= maxPages && orders.length < sum; page += 1) {
    const body = await capture(`list-p${page}`, ENDPOINTS.list, { page, limit: PAGE_LIMIT, status_type: STATUS_TYPE_ALL });
    const info = infoOf<RawOrderListPage>(body);
    if (!info) break;
    sum = Number(info.sum ?? 0);
    const items = info.order_list ?? [];
    orders.push(...items);
    if (items.length === 0) break;
  }
  // Does the server honour a bigger page? (decides the sync page size)
  await capture("list-limit-20", ENDPOINTS.list, { page: 1, limit: 20, status_type: STATUS_TYPE_ALL });
  await capture("list-limit-50", ENDPOINTS.list, { page: 1, limit: 50, status_type: STATUS_TYPE_ALL });
  for (const statusType of [1, 2, 3, 4, 5]) {
    await capture(`list-status-${statusType}`, ENDPOINTS.list, { page: 1, limit: PAGE_LIMIT, status_type: statusType });
  }

  // 2. Archived orders (older than the main window).
  let archived: RawOrderListItem[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const body = await capture(`archive-p${page}`, ENDPOINTS.archive, { page, limit: PAGE_LIMIT });
    const info = infoOf<RawOrderListPage>(body);
    const items = info?.order_list ?? [];
    archived = archived.concat(items);
    if (items.length < PAGE_LIMIT) break;
  }

  // 3. Detail and tracking of every order (capped), archived ones included:
  //    whether get_order_detail answers for an archived billno is an open question.
  const billnos = [...orders, ...archived].map((order) => order.billno).filter((value): value is string => Boolean(value));
  for (const billno of billnos.slice(0, maxOrders)) {
    const short = billno.slice(-6);
    await capture(`detail-${short}`, ENDPOINTS.detail, { billno });
    await capture(`track-${short}`, ENDPOINTS.track, { billno }, "html");
  }

  // 4. Surfaces still being mapped: the SSR pages, the keyword search and the returns endpoints.
  await capture("ssr-list-p1", "/user/orders/list", { page: 1 }, "html");
  if (billnos[0]) await capture("ssr-detail", `/user/orders/detail/${billnos[0]}`, {}, "html");
  const keyword = firstWord(orders);
  if (keyword) await capture("search-order-goods", "/bff-api/order/search_order_goods", { keyword, page: 1, limit: PAGE_LIMIT });
  await capture("returns-page-info", "/bff-api/order-api/order/web/return_and_refund/page_info", {});
  await capture("returns-list-get", "/bff-api/order-api/order/get_return_and_refund_list", { page: 1, limit: PAGE_LIMIT });
  await capturePost("returns-list-post-1", "/bff-api/order-api/order/get_return_and_refund_list", { page: 1, limit: PAGE_LIMIT });
  await capturePost("returns-list-post-2", "/bff-api/order-api/order/get_return_and_refund_list", { page_index: 1, page_size: PAGE_LIMIT });
  await capturePost("returns-list-post-3", "/bff-api/order-api/order/get_return_and_refund_list", { pageIndex: 1, pageSize: PAGE_LIMIT, type: 0 });

  // 5. What the site answers to a bogus session, per surface: the auth heuristics come from here.
  await probeUnauthenticated(config, record);

  console.error(`\n${captures.length} capturas, ${ctx.http.state().requests} requisições, transporte final: ${ctx.http.state().transport}.`);
  if (!write) {
    console.error("\nDry-run. Rode de novo com --write para gravar em task/captures/.");
    await ctx.dispose();
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  for (const item of captures) {
    const extension = item.path.startsWith("/bff-api") ? "json" : "html";
    writeFileSync(join(OUT_DIR, `${item.name}.${extension}`), item.body, { mode: 0o600 });
  }
  writeFileSync(
    join(OUT_DIR, "index.json"),
    JSON.stringify(
      captures.map(({ name, path, ok, status, code, bytes, transport }) => ({ name, path, ok, status, code, bytes, transport })),
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.error(`\nGravado em ${OUT_DIR} (0600, gitignored).`);
  console.error("Próximo passo: bun run scripts/anonymize-fixture.ts");
  await ctx.dispose();
}

async function probeUnauthenticated(
  config: ReturnType<typeof loadConfig>,
  record: (name: string, path: string, outcome: { ok: boolean; status: number | null; code: string | null; body: string }) => void,
): Promise<void> {
  const bogus = createMemorySessionStore({
    version: 1,
    cookies: [
      { name: "sessionID_shein", value: "s%3Ainvalid.invalid", domain: "br.shein.com", path: "/", expires: -1, httpOnly: true, secure: true },
      { name: "memberId", value: "0", domain: ".shein.com", path: "/", expires: -1, httpOnly: false, secure: true },
    ],
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    savedAt: Date.now(),
  });
  const http = createHttp({
    session: bogus,
    baseUrl: config.baseUrl,
    minIntervalMs: config.minIntervalMs,
    jitterMs: config.jitterMs,
    timeoutMs: config.httpTimeoutMs,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const probes: Array<[string, string, Record<string, string | number>, "json" | "html"]> = [
    ["unauth-list", ENDPOINTS.list, { _ver: API_VER, _lang: config.lang, page: 1, limit: 1, status_type: 0 }, "json"],
    ["unauth-detail", ENDPOINTS.detail, { _ver: API_VER, _lang: config.lang, billno: "GSH1000000000000" }, "json"],
    ["unauth-ssr-list", "/user/orders/list", {}, "html"],
    ["unauth-track", ENDPOINTS.track, { billno: "GSH1000000000000" }, "html"],
  ];
  for (const [name, path, query, kind] of probes) {
    const target = new URL(path, `${config.baseUrl}/`);
    for (const [key, value] of Object.entries(query)) target.searchParams.set(key, String(value));
    try {
      const response = await http.serial(() => http.send({ url: target.toString(), method: "GET", kind, label: name }));
      record(name, path, { ok: true, status: response.status, code: kind === "json" ? codeOf(response.body) : null, body: response.body.slice(0, 8192) });
    } catch (error) {
      // The expected outcome: the client itself classifies the answer (auth dead / verdict).
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      record(name, path, { ok: true, status: null, code: null, body: JSON.stringify({ classified: message }) });
    }
  }
}

function codeOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === "string" ? parsed.code : null;
  } catch {
    return null;
  }
}

function infoOf<T>(body: string | null): T | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { code?: string; info?: T | null };
    return parsed.code === "0" && parsed.info ? parsed.info : null;
  } catch {
    return null;
  }
}

function firstWord(orders: RawOrderListItem[]): string | null {
  for (const order of orders) {
    const name = order.orderGoodsList?.[0]?.goods_name;
    const word = name?.split(/\s+/).find((part) => part.length >= 4);
    if (word) return word;
  }
  return null;
}

await main();
