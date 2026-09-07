import { describe, expect, test } from "bun:test";
import { ParseError, SheinApiError } from "../src/core/errors.js";
import { createHttp } from "../src/core/http.js";
import { createMemorySessionStore } from "../src/session/store.js";
import { API_VER, MAX_PAGE_SIZE, SESSION_SUSPECT_CODES, createSheinApi } from "../src/shein/api.js";
import { bffOk, fakeClock, htmlResponse, jsonResponse, scriptedFetch, sessionData, silentLogger } from "./helpers.js";

const BASE = "https://br.acme.test";

function setup(script: Parameters<typeof scriptedFetch>[0]) {
  const clock = fakeClock();
  const fetch = scriptedFetch(script);
  const http = createHttp(
    {
      session: createMemorySessionStore(sessionData({}, ".acme.test")),
      baseUrl: BASE,
      minIntervalMs: 0,
      jitterMs: 0,
      timeoutMs: 30_000,
      log: silentLogger(),
    },
    { fetch, sleep: clock.sleep, now: clock.now, random: () => 0 },
  );
  return { api: createSheinApi(http, { baseUrl: BASE, lang: "pt-br" }), fetch, http };
}

const url = (fetch: ReturnType<typeof scriptedFetch>, index = 0) => new URL(fetch.calls[index]?.url ?? "");

describe("order list", () => {
  test("the page size the server actually honours is 20", () => {
    // limit=20 and limit=50 return the same 20 orders (observed 2026-09-07).
    expect(MAX_PAGE_SIZE).toBe(20);
  });

  test("calls bff-api/order/list with the version, language, page, limit and status tab", async () => {
    const { api, fetch } = setup([bffOk({ order_list: [{ billno: "X" }], sum: 20 })]);
    const page = await api.listOrders({ page: 2, limit: 10, statusType: 0 });
    expect(page.sum).toBe(20);
    expect(page.order_list).toHaveLength(1);
    const u = url(fetch);
    expect(u.pathname).toBe("/bff-api/order/list");
    expect(u.searchParams.get("_ver")).toBe(API_VER);
    expect(u.searchParams.get("_lang")).toBe("pt-br");
    expect(u.searchParams.get("page")).toBe("2");
    expect(u.searchParams.get("limit")).toBe("10");
    expect(u.searchParams.get("status_type")).toBe("0");
    expect(fetch.calls[0]?.init.headers["x-requested-with"]).toBe("XMLHttpRequest");
  });

  test("archived orders (older than a year) come from get_order_archive_list", async () => {
    const { api, fetch } = setup([bffOk({ order_list: [], sum: 1 })]);
    const page = await api.listArchivedOrders({ page: 1, limit: 10 });
    expect(page.sum).toBe(1);
    expect(url(fetch).pathname).toBe("/bff-api/order/get_order_archive_list");
    expect(url(fetch).searchParams.get("status_type")).toBeNull();
  });
});

describe("order detail", () => {
  test("calls get_order_detail with the billno and returns the info object", async () => {
    const { api, fetch } = setup([bffOk({ billno: "GSH1TEST", totalPrice: { amount: "69.98" } })]);
    const detail = await api.getOrderDetail("GSH1TEST");
    expect(detail.billno).toBe("GSH1TEST");
    expect(url(fetch).pathname).toBe("/bff-api/order/get_order_detail");
    expect(url(fetch).searchParams.get("billno")).toBe("GSH1TEST");
  });
});

describe("envelope", () => {
  test("a non-zero code is a SheinApiError carrying code, message and path", async () => {
    const { api } = setup([jsonResponse({ code: "100102", msg: "Erro ao solicitar o parâmetro.", info: null })]);
    try {
      await api.getOrderDetail("GSH1TEST");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SheinApiError);
      expect((error as SheinApiError).code).toBe("100102");
      expect((error as SheinApiError).path).toBe("/bff-api/order/get_order_detail");
      expect((error as Error).message).toContain("Erro ao solicitar o parâmetro.");
    }
  });

  test("the ambiguous session code carries a hint but never kills the session", async () => {
    // 00101001 is what a logged-out caller gets — and also what a wrong
    // parameter gets (observed 2026-09-07). Killing the session on it would
    // make a transient server error look like an expired login, so it stays
    // an api error and `auth_status` is the one that classifies it.
    const code = [...SESSION_SUSPECT_CODES][0] as string;
    const { api, http } = setup([jsonResponse({ code, msg: "Server error, please try again.", info: {} })]);
    const error = await api.listOrders({ page: 1, limit: 10, statusType: 0 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SheinApiError);
    expect((error as Error).message).toMatch(/sess/i);
    expect(http.state().authDead).toBe(false);
  });

  test("a body that is not the envelope is a ParseError", async () => {
    const { api } = setup([htmlResponse("<html>oops</html>")]);
    await expect(api.listOrders({ page: 1, limit: 10, statusType: 0 })).rejects.toThrow(ParseError);
  });

  test("code 0 with a null info is a ParseError too, not a crash later", async () => {
    const { api } = setup([jsonResponse({ code: "0", msg: "ok", info: null })]);
    await expect(api.getOrderDetail("GSH1TEST")).rejects.toThrow(ParseError);
  });
});

describe("SSR order page", () => {
  const ssr = (data: unknown) =>
    htmlResponse(`<html><script nonce="x">var gbRawData = ${JSON.stringify(data)};\nwindow.x=1;</script></html>`);

  test("reads the page's own blob, which is the ONLY surface that honours the tab", async () => {
    // The JSON endpoint ignores `status_type` — every tab answers the same
    // page. The SSR page does not: that is how "did I return anything" is
    // answerable at all (verified against the live site 2026-09-07).
    const { api, fetch } = setup([ssr({ order_list: [], sum: 0, status_type: "4" })]);
    const page = await api.listOrdersPage({ page: 1, statusType: 4 });
    expect(page.sum).toBe(0);
    expect(page.order_list).toEqual([]);
    const u = url(fetch);
    expect(u.pathname).toBe("/user/orders/list");
    expect(u.searchParams.get("status_type")).toBe("4");
    expect(u.searchParams.get("page")).toBe("1");
    expect(fetch.calls[0]?.init.headers.accept).toContain("text/html");
  });

  test("a page without the blob is a ParseError, not an empty result", async () => {
    const { api } = setup([htmlResponse("<html>sem dados</html>")]);
    await expect(api.listOrdersPage({ page: 1, statusType: 4 })).rejects.toThrow(ParseError);
  });
});

describe("tracking page", () => {
  const trackHtml = (blob: string) =>
    `<html><script>\n  gbCommonInfo.pageType = 'trackNew'\n  var gbOrdersTrackSsrData = ${blob}\n</script></html>`;

  test("fetches /orders/track as html and returns the SSR blob", async () => {
    const { api, fetch } = setup([
      htmlResponse(trackHtml('{"isSsr":false,"billno":"GSH1TEST","trackInfo":{"carrier_name":"Imile Brazil","logistics_tracks_list":[]}}')),
    ]);
    const data = await api.getTracking("GSH1TEST");
    expect(data.trackInfo).toEqual({ carrier_name: "Imile Brazil", logistics_tracks_list: [] });
    expect(url(fetch).pathname).toBe("/orders/track");
    expect(url(fetch).searchParams.get("billno")).toBe("GSH1TEST");
    expect(fetch.calls[0]?.init.headers.accept).toContain("text/html");
  });

  test("a page without the blob is a ParseError (layout changed)", async () => {
    const { api } = setup([htmlResponse("<html><script>var gbRawData = {}</script></html>")]);
    await expect(api.getTracking("GSH1TEST")).rejects.toThrow(ParseError);
  });
});

describe("raw", () => {
  test("getRaw sends a json GET to any path under the base url with extra query", async () => {
    const { api, fetch } = setup([bffOk({ x: 1 })]);
    const envelope = await api.getRaw("/bff-api/order/list", { page: 3 });
    expect(envelope).toEqual({ code: "0", msg: "ok", info: { x: 1 } });
    expect(url(fetch).searchParams.get("page")).toBe("3");
    expect(url(fetch).searchParams.get("_ver")).toBe(API_VER);
  });
});
