import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { createContext } from "../src/context.js";
import { SheinAuthError, SheinRiskControlError } from "../src/core/errors.js";
import {
  FETCH_MARKER,
  type PageResult,
  READY_SCRIPT,
  createBrowserFetch,
  fetchScript,
} from "../src/core/browser-transport.js";
import type { Cookie } from "../src/session/jar.js";
import type { BrowserContextLike, PageLike } from "../src/session/login.js";
import { createMemorySessionStore } from "../src/session/store.js";
import { cookie, fakeClock, response, sessionData, silentLogger } from "./helpers.js";

// The browser is faked at the Playwright seam: what matters is which scripts
// reach the page, which cookies are injected, and how in-page results are
// turned back into FetchResponses for core/http.ts.

type LaunchCall = { channel: string; profileDir: string; headless: boolean; userAgent?: string };

function fakeChrome(opts: { readyAfterPolls?: number; results?: PageResult[]; cookiesAfter?: Cookie[]; landOn?: string } = {}) {
  const state = {
    launches: [] as LaunchCall[],
    injected: [] as Cookie[][],
    visited: [] as string[],
    requests: [] as Array<{ url: string; headers: Record<string, string> }>,
    closed: 0,
    readyPolls: 0,
    currentUrl: "about:blank",
    cookies: opts.cookiesAfter ?? sessionData({}, ".acme.test").cookies,
  };
  const results = [...(opts.results ?? [])];
  const page: PageLike = {
    goto: async (url: string) => {
      state.visited.push(url);
      state.currentUrl = opts.landOn ?? url;
      return null;
    },
    url: () => state.currentUrl,
    waitForLoadState: async () => null,
    evaluate: async (script: string) => {
      if (script === READY_SCRIPT) return ++state.readyPolls >= (opts.readyAfterPolls ?? 1);
      if (script.startsWith(FETCH_MARKER)) {
        const request = JSON.parse(script.slice(FETCH_MARKER.length, script.indexOf(" */"))) as {
          url: string;
          headers: Record<string, string>;
        };
        state.requests.push(request);
        const result = results.shift();
        if (!result) throw new Error("fake page: no scripted result");
        return result;
      }
      throw new Error(`fake page: unexpected script ${script.slice(0, 40)}`);
    },
  };
  const context: BrowserContextLike = {
    addCookies: async (cookies) => void state.injected.push(cookies),
    cookies: async () => state.cookies,
    close: async () => void (state.closed += 1),
    newPage: async () => page,
  };
  const launch = async (options: LaunchCall) => {
    state.launches.push(options);
    return context;
  };
  return { state, launch };
}

const BASE = "https://br.acme.test";
const ok = (body: string, url = `${BASE}/bff-api/order/list`): PageResult => ({
  status: 200,
  url,
  contentType: "application/json",
  body,
});

function setup(chrome: ReturnType<typeof fakeChrome>, opts: { idleMs?: number; session?: ReturnType<typeof sessionData> | null } = {}) {
  const clock = fakeClock();
  const session = createMemorySessionStore(opts.session === undefined ? sessionData({}, ".acme.test") : opts.session);
  const log = silentLogger();
  const browserFetch = createBrowserFetch({
    session,
    launch: chrome.launch,
    baseUrl: BASE,
    profileDir: "/tmp/shein-profile-test",
    channel: "chrome",
    log,
    sleep: clock.sleep,
    now: clock.now,
    ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
  });
  const init = {
    method: "GET" as const,
    headers: {
      accept: "application/json, text/plain, */*",
      "x-requested-with": "XMLHttpRequest",
      referer: `${BASE}/user/orders/list`,
      cookie: "secret=1",
      "user-agent": "ua",
    },
    redirect: "manual" as const,
  };
  return { browserFetch, clock, session, log, init };
}

describe("createBrowserFetch", () => {
  test("launches headless with the session's user agent, injects the jar and warms the orders page", async () => {
    const chrome = fakeChrome({ results: [ok('{"code":"0"}')] });
    const { browserFetch, init } = setup(chrome);
    const result = await browserFetch(`${BASE}/bff-api/order/list?page=1`, init);
    expect(result.status).toBe(200);
    expect(await result.text()).toBe('{"code":"0"}');
    expect(chrome.state.launches[0]).toMatchObject({ headless: true, channel: "chrome", profileDir: "/tmp/shein-profile-test" });
    expect(chrome.state.launches[0]?.userAgent).toContain("Chrome/152");
    expect(chrome.state.injected[0]?.some((c) => c.name === "sessionID_shein")).toBe(true);
    expect(chrome.state.visited).toEqual([`${BASE}/user/orders/list`]);
  });

  test("forwards only the page-safe headers: the browser owns cookie, user-agent and referer", async () => {
    const chrome = fakeChrome({ results: [ok("{}")] });
    const { browserFetch, init } = setup(chrome);
    await browserFetch(`${BASE}/bff-api/order/list`, init);
    expect(chrome.state.requests[0]?.headers).toEqual({
      accept: "application/json, text/plain, */*",
      "x-requested-with": "XMLHttpRequest",
    });
  });

  test("reuses the warm page across requests and launches once", async () => {
    const chrome = fakeChrome({ results: [ok("1"), ok("2")] });
    const { browserFetch, init } = setup(chrome);
    await browserFetch(`${BASE}/a`, init);
    await browserFetch(`${BASE}/b`, init);
    expect(chrome.state.launches).toHaveLength(1);
    expect(chrome.state.visited).toHaveLength(1);
    expect(chrome.state.requests.map((r) => r.url)).toEqual([`${BASE}/a`, `${BASE}/b`]);
  });

  test("waits for the SSR data to appear before the first request", async () => {
    const chrome = fakeChrome({ readyAfterPolls: 3, results: [ok("{}")] });
    const { browserFetch, clock, init } = setup(chrome);
    await browserFetch(`${BASE}/a`, init);
    expect(chrome.state.readyPolls).toBe(3);
    expect(clock.slept.length).toBeGreaterThanOrEqual(2);
  });

  test("a warm-up that lands on the login page is a dead session, never a request", async () => {
    const chrome = fakeChrome({ landOn: `${BASE}/user/auth/login?redirection=%2Fuser%2Forders%2Flist` });
    const { browserFetch, init } = setup(chrome);
    await expect(browserFetch(`${BASE}/a`, init)).rejects.toThrow(SheinAuthError);
    expect(chrome.state.requests).toHaveLength(0);
    expect(chrome.state.closed).toBe(1);
  });

  test("a warm-up that lands on a challenge is a risk-control verdict", async () => {
    const chrome = fakeChrome({ landOn: `${BASE}/risk/challenge?x=1` });
    const { browserFetch, init } = setup(chrome);
    await expect(browserFetch(`${BASE}/a`, init)).rejects.toThrow(SheinRiskControlError);
  });

  test("fails without a saved session before touching the browser", async () => {
    const chrome = fakeChrome();
    const { browserFetch, init } = setup(chrome, { session: null });
    await expect(browserFetch(`${BASE}/a`, init)).rejects.toThrow(SheinAuthError);
    expect(chrome.state.launches).toHaveLength(0);
  });

  test("an in-page fetch that ended on the login page comes back as a 302 to it", async () => {
    const chrome = fakeChrome({
      results: [{ status: 200, url: `${BASE}/user/auth/login?x`, contentType: "text/html", body: "<html>" }],
    });
    const { browserFetch, init } = setup(chrome);
    const result = await browserFetch(`${BASE}/a`, init);
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toContain("/user/auth/login");
  });

  test("renewed cookies flow back into the encrypted session", async () => {
    const renewed = [
      ...sessionData({}, ".acme.test").cookies,
      cookie({ name: "AT", value: "fresh-value-123456", domain: ".acme.test", httpOnly: true }),
    ];
    const chrome = fakeChrome({ results: [ok("{}")], cookiesAfter: renewed });
    const { browserFetch, session, init } = setup(chrome);
    const before = session.mtimeMs();
    await browserFetch(`${BASE}/a`, init);
    expect(session.mtimeMs()).not.toBe(before);
    expect(session.load()?.cookies.some((c) => c.name === "AT")).toBe(true);
  });

  test("close is idempotent and releases the browser", async () => {
    const chrome = fakeChrome({ results: [ok("{}")] });
    const { browserFetch, init } = setup(chrome);
    await browserFetch(`${BASE}/a`, init);
    await browserFetch.close();
    await browserFetch.close();
    expect(chrome.state.closed).toBe(1);
  });

  test("the generated in-page script is valid JS that fetches with credentials", async () => {
    const calls: Array<{ url: string; init: unknown }> = [];
    const fakeFetch = async (url: string, options: unknown) => {
      calls.push({ url, init: options });
      return { status: 200, url, headers: { get: () => "application/json" }, text: async () => '{"code":"0"}' };
    };
    const body = fetchScript(`${BASE}/bff-api/order/list?page=1`, { accept: "application/json" });
    const run = new Function("fetch", `return (${body.slice(body.indexOf("*/") + 2)})`) as (fetch: unknown) => Promise<unknown>;
    const result = await run(fakeFetch);
    expect(result).toEqual({
      status: 200,
      url: `${BASE}/bff-api/order/list?page=1`,
      contentType: "application/json",
      body: '{"code":"0"}',
    });
    expect(calls[0]?.init).toEqual({ headers: { accept: "application/json" }, credentials: "include" });
  });
});

describe("context wiring", () => {
  const config = (transport: string) =>
    loadConfig({
      SHEIN_CONFIG_DIR: "/nonexistent/shein-mcp-test",
      SHEIN_BASE_URL: BASE,
      SHEIN_TRANSPORT: transport,
      SHEIN_MIN_INTERVAL_MS: "0",
      SHEIN_JITTER_MS: "0",
    });

  test("transport=browser sends every request through the browser", async () => {
    const chrome = fakeChrome({ results: [ok('{"code":"0","msg":"ok","info":{"order_list":[],"sum":0}}')] });
    const clock = fakeClock();
    const ctx = createContext(config("browser"), {
      launchBrowser: chrome.launch,
      sleep: clock.sleep,
      now: clock.now,
      random: () => 0,
      session: createMemorySessionStore(sessionData({}, ".acme.test")),
      log: silentLogger(),
    });
    const page = await ctx.http.serial(() => ctx.api.listOrders({ page: 1, limit: 10, statusType: 0 }));
    expect(page.sum).toBe(0);
    expect(chrome.state.requests).toHaveLength(1);
    await ctx.dispose();
    expect(chrome.state.closed).toBe(1);
  });

  test("transport=auto starts with plain fetch and falls back to the browser after a verdict", async () => {
    const chrome = fakeChrome({ results: [ok('{"code":"0","msg":"ok","info":{"order_list":[],"sum":7}}')] });
    const clock = fakeClock();
    let plainCalls = 0;
    const ctx = createContext(config("auto"), {
      fetch: async () => {
        plainCalls += 1;
        return response({ status: 403 });
      },
      launchBrowser: chrome.launch,
      sleep: clock.sleep,
      now: clock.now,
      random: () => 0,
      session: createMemorySessionStore(sessionData({}, ".acme.test")),
      log: silentLogger(),
    });
    const page = await ctx.http.serial(() => ctx.api.listOrders({ page: 1, limit: 10, statusType: 0 }));
    expect(page.sum).toBe(7);
    expect(plainCalls).toBe(1);
    expect(chrome.state.requests).toHaveLength(1);
    expect(ctx.http.state().transport).toBe("fallback");
    expect(ctx.http.state().tripped).toBe(false);
    await ctx.dispose();
  });

  test("transport=fetch never launches a browser, whatever happens", async () => {
    const chrome = fakeChrome();
    const clock = fakeClock();
    const ctx = createContext(config("fetch"), {
      fetch: async () => response({ status: 403 }),
      launchBrowser: chrome.launch,
      sleep: clock.sleep,
      now: clock.now,
      random: () => 0,
      session: createMemorySessionStore(sessionData({}, ".acme.test")),
      log: silentLogger(),
    });
    await expect(
      ctx.http.serial(() => ctx.api.listOrders({ page: 1, limit: 10, statusType: 0 })),
    ).rejects.toThrow(SheinRiskControlError);
    expect(chrome.state.launches).toHaveLength(0);
  });
});
