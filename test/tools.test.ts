import { describe, expect, test } from "bun:test";
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
  redirectResponse,
  response,
  scriptedFetch,
  sessionData,
  silentLogger,
} from "./helpers.js";

export function context(
  script: Parameters<typeof scriptedFetch>[0],
  session: ReturnType<typeof sessionData> | null = sessionData({}, ".acme.test"),
): { ctx: Ctx; fetch: ScriptedFetch } {
  const clock = fakeClock();
  const fetch = scriptedFetch(script);
  const config = loadConfig({
    SHEIN_CONFIG_DIR: "/nonexistent/shein-mcp-test",
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
