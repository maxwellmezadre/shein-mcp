import { describe, expect, test } from "bun:test";
import { SheinAuthError, SheinHttpError, SheinRiskControlError } from "../src/core/errors.js";
import {
  BACKOFF_BASE_MS,
  COOLDOWN_MS,
  type CooldownStore,
  type Http,
  MAX_ATTEMPTS,
  backoffMs,
  createHttp,
} from "../src/core/http.js";
import { createMemorySessionStore } from "../src/session/store.js";
import {
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

const BASE = "https://br.acme.test";
const LIST = `${BASE}/bff-api/order/list?_ver=1.1.8&_lang=pt-br&page=1&limit=10`;
const ORDERS_HTML = '<html><script>var gbRawData = {"order_list":[]};</script></html>';
// Every Shein page carries a "Já sou cliente" link in its header — including
// the pages we want. Treating that as a login page killed the session for the
// whole run (observed 2026-09-07 while capturing /orders/track).
const TRACK_HTML =
  '<html><header><a href="/user/auth/login">Já sou cliente</a></header>' +
  '<script>var gbOrdersTrackSsrData = {"billno":"X","trackInfo":{}}</script></html>';

function setup(
  script: Parameters<typeof scriptedFetch>[0],
  opts: {
    session?: ReturnType<typeof sessionData> | null;
    cooldown?: CooldownStore;
    fallback?: Parameters<typeof scriptedFetch>[0];
  } = {},
) {
  const clock = fakeClock();
  const fetch = scriptedFetch(script);
  const fallbackFetch = opts.fallback ? scriptedFetch(opts.fallback) : undefined;
  const log = silentLogger();
  const session = createMemorySessionStore(
    opts.session === undefined ? sessionData({}, ".acme.test") : opts.session,
  );
  const http = createHttp(
    {
      session,
      baseUrl: BASE,
      minIntervalMs: 1000,
      jitterMs: 500,
      timeoutMs: 30_000,
      log,
      ...(opts.cooldown ? { cooldown: opts.cooldown } : {}),
    },
    {
      fetch,
      ...(fallbackFetch ? { fallbackFetch } : {}),
      sleep: clock.sleep,
      now: clock.now,
      random: () => 0.5,
    },
  );
  return { http, fetch, fallbackFetch, clock, log, session };
}

const getJson = (http: Http) => http.send({ url: LIST, method: "GET", kind: "json", label: "order.list" });
const getHtml = (http: Http) =>
  http.send({ url: `${BASE}/user/orders/list`, method: "GET", kind: "html", label: "orders.page" });

describe("session lifecycle", () => {
  test("fails without a session and never spends a request", async () => {
    const { http, fetch } = setup([], { session: null });
    await expect(getJson(http)).rejects.toThrow(SheinAuthError);
    expect(fetch.calls).toHaveLength(0);
  });

  test("sends the session cookies, the captured user agent and the json headers", async () => {
    const { http, fetch } = setup([bffOk({})]);
    await getJson(http);
    const headers = fetch.calls[0]?.init.headers as Record<string, string>;
    expect(headers.cookie).toContain(`sessionID_shein=${SECRET_SESSION}`);
    expect(headers["user-agent"]).toContain("Chrome/152");
    expect(headers.accept).toContain("application/json");
    expect(headers["x-requested-with"]).toBe("XMLHttpRequest");
    expect(headers["accept-language"]).toContain("pt-BR");
    expect(headers.referer).toBe(`${BASE}/user/orders/list`);
    expect(fetch.calls[0]?.init.redirect).toBe("manual");
  });

  test("html requests ask for html and carry no xhr marker", async () => {
    const { http, fetch } = setup([htmlResponse(ORDERS_HTML)]);
    await getHtml(http);
    const headers = fetch.calls[0]?.init.headers as Record<string, string>;
    expect(headers.accept).toContain("text/html");
    expect(headers["x-requested-with"]).toBeUndefined();
  });

  test("exposes the member id and the user agent from the jar", () => {
    const { http } = setup([]);
    expect(http.memberId()).toBe("1234567890");
    expect(http.userAgent()).toContain("Chrome/152");
  });

  test("a redirect to the login page kills the session; the next call spends no request", async () => {
    const { http, fetch } = setup([redirectResponse(`${BASE}/user/auth/login?redirection=%2Fuser%2Forders%2Flist`)]);
    await expect(getHtml(http)).rejects.toThrow(SheinAuthError);
    expect(fetch.calls).toHaveLength(1);
    await expect(getHtml(http)).rejects.toThrow(SheinAuthError);
    expect(fetch.calls).toHaveLength(1);
    expect(http.state().authDead).toBe(true);
  });

  test("a page whose header links to the login page is NOT a dead session", async () => {
    const { http, fetch } = setup([htmlResponse(TRACK_HTML), htmlResponse(ORDERS_HTML)]);
    const result = await getHtml(http);
    expect(result.body).toContain("gbOrdersTrackSsrData");
    expect(http.state().authDead).toBe(false);
    // And the client keeps working afterwards.
    await getHtml(http);
    expect(fetch.calls).toHaveLength(2);
  });

  test("reloads the jar after the user re-logged in, without an MCP restart", async () => {
    const { http, fetch, session } = setup([
      redirectResponse(`${BASE}/user/auth/login`),
      bffOk({}),
    ]);
    await expect(getJson(http)).rejects.toThrow(SheinAuthError);
    session.save(sessionData({ savedAt: 2 }, ".acme.test")); // `shein login` elsewhere
    await getJson(http);
    expect(fetch.calls).toHaveLength(2);
  });
});

describe("pacing", () => {
  test("waits minInterval + jitter between requests", async () => {
    const { http, clock } = setup([bffOk(1), bffOk(2), bffOk(3)]);
    await getJson(http);
    await getJson(http);
    await getJson(http);
    // random() is 0.5 → 1000 + 0.5 * 500 = 1250 ms; the first request waits nothing.
    expect(clock.slept).toEqual([1250, 1250]);
  });

  test("serialises concurrent callers: never more than one request in flight", async () => {
    const { http, fetch } = setup([bffOk(1), bffOk(2), bffOk(3)]);
    const call = (n: number) =>
      http.serial(() => http.send({ url: LIST, method: "GET", kind: "json", label: `r${n}` }));
    await Promise.all([call(1), call(2), call(3)]);
    expect(fetch.maxInFlight).toBe(1);
    expect(fetch.calls).toHaveLength(3);
  });

  test("keeps FIFO order even when one request rejects", async () => {
    const { http } = setup([response({ status: 400 }), bffOk(2)]);
    const order: string[] = [];
    const first = http
      .serial(() => http.send({ url: LIST, method: "GET", kind: "json", label: "a" }))
      .catch(() => {
        order.push("a");
      });
    const second = http
      .serial(() => http.send({ url: LIST, method: "GET", kind: "json", label: "b" }))
      .then(() => {
        order.push("b");
      });
    await Promise.all([first, second]);
    expect(order).toEqual(["a", "b"]);
  });
});

describe("retries", () => {
  test("backs off exponentially on 5xx and gives up after MAX_ATTEMPTS", async () => {
    const { http, clock, fetch } = setup([
      response({ status: 503 }),
      response({ status: 503 }),
      response({ status: 503 }),
      response({ status: 503 }),
    ]);
    await expect(getJson(http)).rejects.toThrow(SheinHttpError);
    expect(fetch.calls).toHaveLength(MAX_ATTEMPTS);
    expect(clock.slept.filter((ms) => ms >= BACKOFF_BASE_MS)).toEqual([5000, 10_000, 20_000]);
  });

  test("caps the backoff at five minutes", () => {
    expect(backoffMs(1)).toBe(5000);
    expect(backoffMs(10)).toBe(300_000);
  });

  test("recovers when a retry succeeds", async () => {
    const { http, fetch } = setup([response({ status: 500 }), bffOk({})]);
    const result = await getJson(http);
    expect(result.status).toBe(200);
    expect(fetch.calls).toHaveLength(2);
  });

  test("retries a network error and then reports it as SheinHttpError(0)", async () => {
    const boom = () => {
      throw new Error("ECONNRESET");
    };
    const { http, fetch } = setup([boom, boom, boom, boom]);
    await expect(getJson(http)).rejects.toThrow(/Falha de rede/);
    expect(fetch.calls).toHaveLength(MAX_ATTEMPTS);
  });

  test("does not retry a 4xx — it is a verdict, not a hiccup", async () => {
    const { http, fetch } = setup([response({ status: 404 })]);
    await expect(getJson(http)).rejects.toThrow(SheinHttpError);
    expect(fetch.calls).toHaveLength(1);
  });
});

describe("cookie renewal", () => {
  test("absorbs a rotated cookie and persists it once", async () => {
    const { http, session } = setup([
      bffOk({}, { setCookie: ["AT=fresh-token-value-9876; Domain=.acme.test; Path=/; HttpOnly"] }),
      bffOk({}),
    ]);
    await getJson(http);
    expect(http.cookies().some((c) => c.name === "AT" && c.value === "fresh-token-value-9876")).toBe(true);
    expect(session.load()?.cookies.some((c) => c.value === "fresh-token-value-9876")).toBe(true);
  });

  test("does not rewrite the file when the response repeats the same cookie", async () => {
    const { http, session } = setup([
      bffOk({}, { setCookie: ["memberId=1234567890; Domain=.acme.test; Path=/; Secure"] }),
    ]);
    const before = session.mtimeMs();
    await getJson(http);
    expect(session.mtimeMs()).toBe(before);
  });
});

describe("anti-bot", () => {
  const cooldownStore = () => {
    const value: { until: number | null } = { until: null };
    const store: CooldownStore = {
      get: () => value.until,
      set: (until) => {
        value.until = until;
      },
    };
    return { store, value };
  };

  test("a 403 without a fallback transport trips the breaker and persists the cooldown", async () => {
    const { store, value } = cooldownStore();
    const { http, fetch, clock } = setup([response({ status: 403 })], { cooldown: store });
    await expect(getJson(http)).rejects.toThrow(SheinRiskControlError);
    expect(http.state().tripped).toBe(true);
    expect(value.until).toBe(clock.now() + COOLDOWN_MS);
    await expect(getJson(http)).rejects.toThrow(SheinRiskControlError);
    expect(fetch.calls).toHaveLength(1);
  });

  test("a challenge page trips the breaker as well", async () => {
    const { http } = setup([htmlResponse("<html><title>Just a moment...</title><div id=\"challenge-form\"></div></html>")]);
    await expect(getHtml(http)).rejects.toThrow(SheinRiskControlError);
    expect(http.state().tripped).toBe(true);
  });

  test("with a fallback transport the same request is retried there, once, and stays there", async () => {
    const { http, fetch, fallbackFetch, log } = setup([response({ status: 403 })], {
      fallback: [bffOk({ sum: 1 }), bffOk({ sum: 2 })],
    });
    const result = await getJson(http);
    expect(result.status).toBe(200);
    expect(fetch.calls).toHaveLength(1);
    expect(fallbackFetch?.calls).toHaveLength(1);
    expect(http.state().transport).toBe("fallback");
    expect(http.state().tripped).toBe(false);
    await getJson(http);
    expect(fetch.calls).toHaveLength(1);
    expect(fallbackFetch?.calls).toHaveLength(2);
    expect(log.lines.some((line) => /fallback/.test(line))).toBe(true);
  });

  test("a second verdict, on the fallback, trips the breaker", async () => {
    const { store, value } = cooldownStore();
    const { http, fallbackFetch } = setup([response({ status: 403 })], {
      fallback: [response({ status: 403 })],
      cooldown: store,
    });
    await expect(getJson(http)).rejects.toThrow(SheinRiskControlError);
    expect(fallbackFetch?.calls).toHaveLength(1);
    expect(http.state().tripped).toBe(true);
    expect(value.until).not.toBeNull();
  });

  test("a persisted cooldown from another process blocks before any request", async () => {
    const clockStart = 1_757_000_000_000;
    const cooldown: CooldownStore = { get: () => clockStart + 60_000, set: () => undefined };
    const { http, fetch } = setup([bffOk({})], { cooldown });
    await expect(getJson(http)).rejects.toThrow(SheinRiskControlError);
    expect(fetch.calls).toHaveLength(0);
    expect(http.cooldownUntil()).toBe(clockStart + 60_000);
  });

  test("an expired cooldown lets requests through again", async () => {
    const cooldown: CooldownStore = { get: () => 1, set: () => undefined };
    const { http } = setup([bffOk({})], { cooldown });
    await getJson(http);
    expect(http.cooldownUntil()).toBeNull();
  });
});

describe("privacy", () => {
  test("error messages carry the label, never the url or the cookies", async () => {
    const { http } = setup([response({ status: 418 })]);
    try {
      await http.send({ url: `${BASE}/bff-api/order/get_order_detail?billno=GSH1ABCDEF12345`, method: "GET", kind: "json", label: "order.detail" });
      throw new Error("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("order.detail");
      expect(message).not.toContain("GSH1ABCDEF12345");
      expect(message).not.toContain("session-secret-value-0001");
    }
  });

  test("logs never contain a header", async () => {
    const { http, log } = setup([jsonResponse({ code: "0" })]);
    await getJson(http);
    expect(log.lines.join("\n")).not.toContain("session-secret-value-0001");
  });
});
