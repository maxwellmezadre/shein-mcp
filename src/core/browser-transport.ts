import type { BrowserChannel } from "../config.js";
import { type Cookie, inSiteDomain } from "../session/jar.js";
import {
  type BrowserContextLike,
  LOGIN_PROBE_SCRIPT,
  type PageLike,
  launchOptions,
  loadPlaywright,
  registrableDomain,
} from "../session/login.js";
import type { SessionData, SessionStore } from "../session/store.js";
import { SheinAuthError, SheinHttpError, SheinRiskControlError } from "./errors.js";
import type { FetchInit, FetchLike, FetchResponse } from "./http.js";
import type { Logger } from "./logger.js";

// Why a browser: the order endpoints answer a plain cookie replay today, but
// the site fingerprints devices (armorToken, smdeviceid, forterToken) and a
// crawler-shaped client may earn a risk-control verdict at any time. When that
// happens, the SAME requests are issued from inside a headless Chrome that
// loaded the orders page with the user's jar: the site's own device identity
// signs them, and nothing is imitated. The page is warmed once per process and
// closed after an idle period. Everything else (serialisation, pacing,
// backoff, breaker, envelope) stays in core/http.ts: this is just a FetchLike.

/** The orders page only ships `gbRawData.order_list` to a logged-in user. */
export const READY_SCRIPT = LOGIN_PROBE_SCRIPT;
export const FETCH_MARKER = "/*shein-mcp fetch ";

/** The only headers that go into the page; the browser owns cookie, UA and referer. */
const PAGE_HEADERS = ["accept", "x-requested-with", "content-type"];
const READY_ATTEMPTS = 40;
const READY_POLL_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_MS = 5 * 60_000;
const LOGIN_PATH = /\/user\/(auth\/)?login/i;
const CHALLENGE_PATH = /captcha|challenge|risk|verify/i;

export type PageResult = { status: number; url: string; contentType: string; body: string };

export type LaunchOptions = {
  channel: BrowserChannel;
  profileDir: string;
  headless: boolean;
  userAgent?: string;
};
export type LaunchBrowser = (opts: LaunchOptions) => Promise<BrowserContextLike>;

export type BrowserFetchOptions = {
  session: SessionStore;
  launch: LaunchBrowser;
  baseUrl: string;
  profileDir: string;
  channel: BrowserChannel;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Close the browser after this long without requests; 0 disables. */
  idleMs?: number;
};

export type BrowserFetch = FetchLike & { close(): Promise<void> };

/** Real browser: lazy import keeps playwright-core off the MCP fast path. */
export const launchWithPlaywright: LaunchBrowser = async (opts) => {
  const playwright = await loadPlaywright();
  return playwright.chromium.launchPersistentContext(opts.profileDir, {
    ...launchOptions(opts.channel, opts.headless),
    // Headless Chrome announces itself as "HeadlessChrome"; the session's real UA keeps the anti-bot quiet.
    ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
  });
};

/** First line = a comment carrying the JSON request (tests parse it); the rest runs in the page. */
export function fetchScript(
  url: string,
  headers: Record<string, string>,
  method: "GET" | "POST" = "GET",
  body?: string,
): string {
  const request = JSON.stringify({ url, headers, method, body });
  const extra = method === "POST" ? ", method: request.method, body: request.body" : "";
  // `Accept: */*` would close the marker comment early: keep `*/` out of it.
  const marker = request.replace(/\*\//g, "*\\u002f");
  return `${FETCH_MARKER}${marker} */
(async () => {
  const request = ${request};
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("in-page fetch timeout")), ${REQUEST_TIMEOUT_MS}); });
  try {
    const response = await Promise.race([fetch(request.url, { headers: request.headers, credentials: "include"${extra} }), timeout]);
    return { status: response.status, url: response.url, contentType: response.headers.get("content-type") ?? "", body: await response.text() };
  } finally {
    clearTimeout(timer);
  }
})()`;
}

const signature = (cookies: readonly Cookie[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).sort().join(";");

/** In-page fetch follows redirects; the final URL says whether it was bounced. */
function toResponse(result: PageResult): FetchResponse {
  const bounced = LOGIN_PATH.test(result.url) || CHALLENGE_PATH.test(result.url) ? result.url : null;
  const status = bounced ? 302 : result.status;
  const headers = new Map<string, string>([["content-type", result.contentType]]);
  if (bounced) headers.set("location", bounced);
  return {
    status,
    statusText: "",
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null, getSetCookie: () => [] },
    text: async () => result.body,
  };
}

export function createBrowserFetch(opts: BrowserFetchOptions): BrowserFetch {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? (() => Date.now());
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const registrable = registrableDomain(opts.baseUrl);

  let context: BrowserContextLike | null = null;
  let page: PageLike | null = null;
  let jar: SessionData | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  async function close(): Promise<void> {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const current = context;
    context = null;
    page = null;
    if (current) await current.close().catch(() => undefined);
  }

  function touch(): void {
    if (idleTimer) clearTimeout(idleTimer);
    if (idleMs <= 0) return;
    idleTimer = setTimeout(() => void close(), idleMs);
    (idleTimer as { unref?: () => void }).unref?.();
  }

  /** Launch, inject the jar, load the orders page and wait for its SSR data. */
  async function ensurePage(): Promise<PageLike> {
    if (page) return page;
    jar = opts.session.load();
    if (!jar) throw new SheinAuthError("Nenhuma sessão da Shein salva.");
    opts.log.info("starting headless browser for Shein requests");
    context = await opts.launch({
      channel: opts.channel,
      profileDir: opts.profileDir,
      headless: true,
      userAgent: jar.userAgent,
    });
    try {
      await context.addCookies?.(jar.cookies);
      const fresh = await context.newPage();
      await fresh.goto(`${opts.baseUrl}/user/orders/list`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const landed = fresh.url();
      if (CHALLENGE_PATH.test(landed)) {
        throw new SheinRiskControlError("A Shein exigiu verificação anti-bot ao abrir a página de pedidos no navegador.");
      }
      if (LOGIN_PATH.test(landed)) {
        throw new SheinAuthError("A Shein não aceitou a sessão salva ao abrir a página de pedidos no navegador.");
      }
      for (let attempt = 0; ; attempt += 1) {
        if ((await fresh.evaluate(READY_SCRIPT)) === true) break;
        if (attempt >= READY_ATTEMPTS) {
          throw new SheinHttpError(0, "A página de pedidos da Shein não renderizou no navegador (sem gbRawData). Tente de novo.");
        }
        await sleep(READY_POLL_MS);
      }
      page = fresh;
      return fresh;
    } catch (error) {
      await close();
      throw error;
    }
  }

  /** The browser renews cookies itself; mirror them into the encrypted jar when they change. */
  async function persistCookies(): Promise<void> {
    if (!context || !jar) return;
    const cookies = (await context.cookies()).filter((cookie) => inSiteDomain(cookie.domain, registrable));
    if (cookies.length === 0 || signature(cookies) === signature(jar.cookies)) return;
    jar = { ...jar, cookies, savedAt: now() };
    try {
      opts.session.save(jar);
    } catch (error) {
      opts.log.warn(`could not persist renewed cookies: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const browserFetch = (async (url: string, init: FetchInit): Promise<FetchResponse> => {
    const current = await ensurePage();
    const headers: Record<string, string> = {};
    for (const name of PAGE_HEADERS) {
      const value = init.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    const result = (await current.evaluate(fetchScript(url, headers, init.method, init.body))) as PageResult;
    await persistCookies();
    touch();
    return toResponse(result);
  }) as BrowserFetch;
  browserFetch.close = close;
  return browserFetch;
}
