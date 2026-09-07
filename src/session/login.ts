import { mkdirSync, rmSync } from "node:fs";
import type { BrowserChannel } from "../config.js";
import type { Ctx } from "../context.js";
import { LoginError } from "../core/errors.js";
import { type Cookie, inSiteDomain, memberIdFromJar } from "./jar.js";

// Interactive login. The user types the password (and whatever else Shein
// asks: SMS, Google, captcha) in a real browser window; this code never sees a
// credential and only keeps the resulting cookie jar.
//
// Two things make this work where a naive script fails:
//   1. `context.cookies()` captures the HttpOnly session cookies that
//      `document.cookie` cannot see. Copying document.cookie by hand produces
//      a jar that authenticates nothing.
//   2. "Logged in" is decided in two steps: the readable `memberId` cookie
//      appears, and the orders page then renders its SSR data
//      (`gbRawData.order_list`) — the login page carries no such blob.

export type LoginResult = {
  cookieCount: number;
  httpOnlyCount: number;
  memberId: string | null;
  savedAt: string;
};

export type LoginOptions = {
  timeoutMs?: number;
  channel?: BrowserChannel;
  /** Wipe the persistent profile first (start from a clean browser). */
  fresh?: boolean;
  report?: (message: string) => void;
};

/** Minimal slice of Playwright we depend on, so tests need no browser. */
export type PageLike = {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
  url(): string;
  waitForLoadState?(state: string, options?: Record<string, unknown>): Promise<unknown>;
};
export type BrowserContextLike = {
  newPage(): Promise<PageLike>;
  cookies(): Promise<Cookie[]>;
  addCookies?(cookies: Cookie[]): Promise<void>;
  close(): Promise<void>;
};
export type PlaywrightLike = {
  chromium: {
    launchPersistentContext(profileDir: string, options: Record<string, unknown>): Promise<BrowserContextLike>;
  };
};

export type LoginDeps = {
  importPlaywright?: () => Promise<PlaywrightLike>;
  sleep?: (ms: number) => Promise<void>;
};

export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 2_000;
const REPORT_EVERY_MS = 30_000;

export const PLAYWRIGHT_HINT =
  "Instale o Google Chrome, ou rode `bunx playwright install chromium` e use " +
  "SHEIN_BROWSER_CHANNEL=chromium. Sem navegador nenhum, `shein login --from-browser arc` " +
  "(ou chrome) importa a sessão de um navegador em que você já está logado.";

/** Runs inside the page: the orders page only ships `order_list` to a logged-in user. */
export const LOGIN_PROBE_SCRIPT = "!!(window.gbRawData && Array.isArray(window.gbRawData.order_list))";

export function launchOptions(channel: BrowserChannel, headless = false): Record<string, unknown> {
  return {
    channel,
    headless,
    locale: "pt-BR",
    viewport: null,
    // Headless or not, Chrome reports navigator.webdriver=true unless this is
    // set, and anti-fraud SDKs read it.
    args: ["--disable-blink-features=AutomationControlled"],
    // Drops the "controlled by automated software" banner from the window.
    ignoreDefaultArgs: ["--enable-automation"],
  };
}

export async function loadPlaywright(deps: LoginDeps = {}): Promise<PlaywrightLike> {
  if (deps.importPlaywright) return deps.importPlaywright();
  try {
    // Dynamic on purpose: the MCP fast path must never pay for playwright-core.
    return (await import("playwright-core")) as unknown as PlaywrightLike;
  } catch (error) {
    throw new LoginError(
      `Não consegui carregar o playwright-core. ${PLAYWRIGHT_HINT}\nDetalhe: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** The registrable domain of the storefront (`shein.com` for `br.shein.com`). */
export const registrableDomain = (baseUrl: string): string =>
  new URL(baseUrl).hostname.split(".").slice(-2).join(".");

export async function runLogin(ctx: Ctx, options: LoginOptions = {}, deps: LoginDeps = {}): Promise<LoginResult> {
  const { config } = ctx;
  const report = options.report ?? ((message: string) => ctx.log.info(message));
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const channel = options.channel ?? config.browserChannel;

  if (options.fresh) rmSync(config.browserProfileDir, { recursive: true, force: true });
  mkdirSync(config.browserProfileDir, { recursive: true, mode: 0o700 });

  const sleep = deps.sleep ?? realSleep;
  const playwright = await loadPlaywright(deps);
  let context: BrowserContextLike;
  try {
    context = await playwright.chromium.launchPersistentContext(config.browserProfileDir, launchOptions(channel));
  } catch (error) {
    throw new LoginError(
      `Não consegui abrir o navegador (canal: ${channel}). ${PLAYWRIGHT_HINT}\nDetalhe: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const page = await context.newPage();
    const ordersUrl = `${config.baseUrl}/user/orders/list`;
    // Unauthenticated, the orders page shows the login form; after the login
    // the site lands here by itself.
    await page.goto(ordersUrl);
    report("Faça login na janela do navegador (senha, SMS, Google, captcha — o que a Shein pedir). Aguardando…");

    const startedAt = ctx.now();
    const deadline = startedAt + timeoutMs;
    let lastReport = startedAt;
    for (;;) {
      if (memberIdFromJar(await readCookies(context))) {
        if (await isLoggedIn(page)) break;
        // The cookie is there but the document may predate the login: reload the orders page.
        await page.goto(ordersUrl);
        await page.waitForLoadState?.("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
        if (await isLoggedIn(page)) break;
      }
      if (ctx.now() >= deadline) {
        throw new LoginError(
          `Login não concluído em ${Math.round(timeoutMs / 60_000)} minutos. Rode \`shein login\` de novo.`,
        );
      }
      if (ctx.now() - lastReport >= REPORT_EVERY_MS) {
        report(`Ainda aguardando o login… (${Math.round((ctx.now() - startedAt) / 1000)} s)`);
        lastReport = ctx.now();
      }
      await sleep(POLL_MS);
    }

    const registrable = registrableDomain(config.baseUrl);
    const cookies = (await readCookies(context)).filter((cookie) => inSiteDomain(cookie.domain, registrable));
    const userAgent = String(await page.evaluate("navigator.userAgent"));
    const savedAt = ctx.now();
    ctx.session.save({ version: 1, cookies, userAgent, savedAt });
    ctx.http.resetSession();

    return {
      cookieCount: cookies.length,
      httpOnlyCount: cookies.filter((cookie) => cookie.httpOnly).length,
      memberId: memberIdFromJar(cookies),
      savedAt: new Date(savedAt).toISOString(),
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** The user may simply close the window; that is a LoginError, not a Playwright stack trace. */
async function readCookies(context: BrowserContextLike): Promise<Cookie[]> {
  try {
    return await context.cookies();
  } catch (error) {
    throw new LoginError(
      `O navegador foi fechado antes de o login terminar. Rode \`shein login\` de novo e complete o login na janela.\nDetalhe: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function isLoggedIn(page: PageLike): Promise<boolean> {
  try {
    return (await page.evaluate(LOGIN_PROBE_SCRIPT)) === true;
  } catch {
    // The page may still be navigating; try again on the next tick.
    return false;
  }
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
