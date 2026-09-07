import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { type Ctx, createContext } from "../src/context.js";
import { LoginError } from "../src/core/errors.js";
import type { Cookie } from "../src/session/jar.js";
import {
  type BrowserContextLike,
  type PageLike,
  LOGIN_PROBE_SCRIPT,
  launchOptions,
  runLogin,
} from "../src/session/login.js";
import { createMemorySessionStore } from "../src/session/store.js";
import { cookie, fakeClock, scriptedFetch, silentLogger } from "./helpers.js";

// No browser is launched: the Playwright slice we depend on is injected.

function fakePlaywright(opts: {
  /** `memberId` appears in the jar only after this many cookie polls. */
  loginAfterPolls?: number;
  onLaunch?: (dir: string, options: Record<string, unknown>) => void;
  failLaunch?: boolean;
}) {
  let polls = 0;
  let renderedLoggedIn = false;
  const visited: string[] = [];
  const loggedIn = () => polls > (opts.loginAfterPolls ?? 0);
  const page: PageLike = {
    goto: async (url) => {
      visited.push(url);
      // A document rendered after the login carries the SSR data; one rendered before does not.
      renderedLoggedIn = loggedIn() && url.includes("/user/orders/list");
      return null;
    },
    evaluate: async (script) => {
      if (script === "navigator.userAgent") return "Mozilla/5.0 Chrome/152.0.0.0";
      if (script === LOGIN_PROBE_SCRIPT) return renderedLoggedIn;
      return null;
    },
    url: () => visited[visited.length - 1] ?? "",
    waitForLoadState: async () => null,
  };
  let closed = false;
  const context: BrowserContextLike = {
    newPage: async () => page,
    cookies: async () => {
      polls += 1;
      const jar: Cookie[] = [
        cookie({ name: "sessionID_shein", value: "s%3Asecret", domain: "br.shein.com", httpOnly: true }),
        cookie({ name: "other", value: "1", domain: ".example.com" }),
      ];
      if (loggedIn()) jar.push(cookie({ name: "memberId", value: "1234567890" }));
      return jar;
    },
    close: async () => {
      closed = true;
    },
  };
  return {
    playwright: {
      chromium: {
        launchPersistentContext: async (dir: string, options: Record<string, unknown>) => {
          opts.onLaunch?.(dir, options);
          if (opts.failLaunch) throw new Error("Executable doesn't exist");
          return context;
        },
      },
    },
    visited,
    pollCount: () => polls,
    isClosed: () => closed,
  };
}

function context(): { ctx: Ctx; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shein-login-"));
  const clock = fakeClock();
  const config = loadConfig({ SHEIN_CONFIG_DIR: dir, SHEIN_TRANSPORT: "fetch" });
  const ctx = createContext(config, {
    fetch: scriptedFetch([]),
    now: clock.now,
    session: createMemorySessionStore(null),
    log: silentLogger(),
  });
  return { ctx, dir };
}

describe("launchOptions", () => {
  test("hides the automation signals the anti-bot SDK reads", () => {
    const options = launchOptions("chrome");
    expect(options.channel).toBe("chrome");
    expect(options.headless).toBe(false);
    expect(options.locale).toBe("pt-BR");
    expect(options.args).toContain("--disable-blink-features=AutomationControlled");
    expect(options.ignoreDefaultArgs).toContain("--enable-automation");
  });
});

describe("LOGIN_PROBE_SCRIPT", () => {
  test("asks the rendered orders page for its SSR data instead of matching a url", () => {
    expect(LOGIN_PROBE_SCRIPT).toContain("gbRawData");
    expect(LOGIN_PROBE_SCRIPT).toContain("order_list");
  });
});

describe("runLogin", () => {
  test("polls until memberId appears, confirms the orders page renders, then saves the jar", async () => {
    const { ctx, dir } = context();
    const fake = fakePlaywright({ loginAfterPolls: 2 });
    const result = await runLogin(
      ctx,
      { timeoutMs: 60_000, report: () => undefined },
      { importPlaywright: async () => fake.playwright, sleep: async () => undefined },
    );
    expect(fake.pollCount()).toBeGreaterThanOrEqual(3);
    expect(result.memberId).toBe("1234567890");
    // The foreign-domain cookie is dropped; the HttpOnly session cookie is kept.
    expect(result.cookieCount).toBe(2);
    expect(result.httpOnlyCount).toBe(1);
    expect(ctx.session.load()?.userAgent).toContain("Chrome/152");
    // Opens the orders page (login bounces there) and lands on it again once logged in.
    expect(fake.visited.filter((url) => url.includes("/user/orders/list")).length).toBeGreaterThanOrEqual(2);
    expect(fake.isClosed()).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("times out with an actionable message instead of hanging forever", async () => {
    const { ctx, dir } = context();
    const fake = fakePlaywright({ loginAfterPolls: Number.POSITIVE_INFINITY });
    await expect(
      runLogin(
        ctx,
        { timeoutMs: 0, report: () => undefined },
        { importPlaywright: async () => fake.playwright, sleep: async () => undefined },
      ),
    ).rejects.toThrow(LoginError);
    expect(ctx.session.load()).toBeNull();
    expect(fake.isClosed()).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a browser that will not open explains how to fix it", async () => {
    const { ctx, dir } = context();
    const fake = fakePlaywright({ failLaunch: true });
    await expect(
      runLogin(ctx, { report: () => undefined }, { importPlaywright: async () => fake.playwright }),
    ).rejects.toThrow(/playwright install chromium|Google Chrome/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("uses the persistent profile directory from the config", async () => {
    const { ctx, dir } = context();
    let launchedIn = "";
    const fake = fakePlaywright({
      loginAfterPolls: 0,
      onLaunch: (target) => {
        launchedIn = target;
      },
    });
    await runLogin(
      ctx,
      { report: () => undefined },
      { importPlaywright: async () => fake.playwright, sleep: async () => undefined },
    );
    expect(launchedIn).toBe(ctx.config.browserProfileDir);
    rmSync(dir, { recursive: true, force: true });
  });
});
