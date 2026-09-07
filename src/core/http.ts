import { type Cookie, cookieHeader, memberIdFromJar, mergeSetCookie } from "../session/jar.js";
import type { SessionData, SessionStore } from "../session/store.js";
import { SheinAuthError, SheinHttpError, SheinRiskControlError } from "./errors.js";
import type { Logger } from "./logger.js";

// The single funnel to Shein. It exists to enforce the anti-bot contract in
// ONE place:
//   - strictly serial: requests never overlap, even from concurrent tool calls;
//   - a minimum gap plus random jitter between requests;
//   - exponential backoff on transient failures (network, 429, 5xx);
//   - one automatic switch to a fallback transport (the headless browser) on
//     the first risk-control verdict, and a circuit breaker with a cooldown
//     that survives the process on the second, so a retry loop cannot deepen
//     an anti-bot block;
//   - `redirect: "manual"`, because a 302 to the login page is a dead session,
//     not a page worth downloading (that redirect is the ONLY reliable
//     logged-out signal: the JSON code is ambiguous and every page links to
//     the login page from its header);
//   - Set-Cookie absorption, so renewed cookies go back to the encrypted jar.
// It knows nothing about the bff-api envelope — that lives in src/shein. Every
// temporal collaborator (fetch, sleep, now, random) is injectable so the tests
// are deterministic without fake timers.

export type FetchResponse = {
  status: number;
  statusText: string;
  ok: boolean;
  headers: { get(name: string): string | null; getSetCookie(): string[] };
  text(): Promise<string>;
};
export type FetchInit = {
  method: "GET" | "POST";
  headers: Record<string, string>;
  redirect: "manual";
  body?: string;
  signal?: AbortSignal;
};
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export type HttpDeps = {
  fetch?: FetchLike;
  /** Used for the rest of the process after the first risk-control verdict on `fetch`. */
  fallbackFetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
};

export type RequestKind = "json" | "html";

export type HttpRequest = {
  url: string;
  method: "GET" | "POST";
  /** Decides the Accept header and which dead-session/challenge heuristics apply to the body. */
  kind: RequestKind;
  /** Extra headers; `cookie`, `user-agent` and the kind headers are added by this layer. */
  headers?: Record<string, string>;
  body?: string;
  /** Short label for logs and error messages (never the full URL: it carries ids). */
  label: string;
};

export type HttpResponse = {
  status: number;
  headers: { get(name: string): string | null };
  body: string;
};

export type HttpState = {
  tripped: boolean;
  authDead: boolean;
  requests: number;
  lastRequestAt: number | null;
  /** Which transport is serving requests now. */
  transport: "primary" | "fallback";
};

/** Persisted anti-bot cooldown (unix ms); survives the process. */
export type CooldownStore = { get(): number | null; set(until: number): void };

export type HttpOptions = {
  session: SessionStore;
  baseUrl: string;
  minIntervalMs: number;
  jitterMs: number;
  timeoutMs: number;
  log: Logger;
  cooldown?: CooldownStore;
};

export type Http = {
  /** Runs `fn` in the serial queue: the next one starts only after it settles. */
  serial<T>(fn: () => Promise<T>): Promise<T>;
  /** Sends one paced request with the session cookies. Call it inside `serial`. */
  send(request: HttpRequest): Promise<HttpResponse>;
  memberId(): string | null;
  userAgent(): string;
  cookies(): readonly Cookie[];
  /** Trips the breaker for the rest of the process and persists the cooldown. */
  trip(reason: string): never;
  /** Marks the session dead so the next call fails without spending a request. */
  markAuthDead(message: string): never;
  state(): HttpState;
  /** Active anti-bot cooldown (unix ms) or null. */
  cooldownUntil(): number | null;
  /** Forget the loaded jar so the next request re-reads the store (after an in-process login). */
  resetSession(): void;
};

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 4;
/** After an anti-bot verdict, no request for this long — even from a new process. */
export const COOLDOWN_MS = 30 * 60_000;

export const RISK_MESSAGE =
  "A Shein aplicou um bloqueio anti-bot nesta sessão. O cliente foi desativado neste processo: " +
  "abra br.shein.com no seu navegador, resolva a verificação se aparecer, espere alguns minutos " +
  "e rode `shein login`.";

const LOGIN_PATH = /\/user\/(auth\/)?login/i;
const CHALLENGE_PATH = /captcha|challenge|risk|verify/i;

/** Cloudflare / risk-control interstitials come as HTML whatever was requested. */
export function isChallengeHtml(body: string): boolean {
  return /Just a moment|challenge-form|cf-challenge|risk_control|riskControl|captcha-verify/i.test(body);
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const realFetch: FetchLike = (url, init) =>
  globalThis.fetch(url, init as RequestInit) as unknown as Promise<FetchResponse>;

export const backoffMs = (attempt: number): number =>
  Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);

const isTransient = (status: number): boolean => status === 429 || status >= 500;

export function createHttp(opts: HttpOptions, deps: HttpDeps = {}): Http {
  const primary = deps.fetch ?? realFetch;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? Math.random;
  const { session, log } = opts;

  let jar: SessionData | null = null;
  let loadedMtime: number | null = null;
  let lastRequestAt = Number.NEGATIVE_INFINITY;
  let tripped = false;
  let authDead = false;
  let usingFallback = false;
  let requests = 0;
  let chain: Promise<unknown> = Promise.resolve();

  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /**
   * Loads the jar lazily and reloads it after the user ran `shein login`
   * (the session file changed since we loaded it) — no MCP restart needed.
   */
  function ensureSession(): SessionData {
    const mtime = session.mtimeMs();
    if (jar === null || (authDead && mtime !== loadedMtime)) {
      jar = session.load();
      loadedMtime = mtime;
      authDead = false;
    }
    if (jar === null) throw new SheinAuthError("Nenhuma sessão da Shein salva.");
    if (authDead) throw new SheinAuthError("A sessão da Shein expirou ou foi rejeitada.");
    return jar;
  }

  const untilLabel = (until: number): string =>
    new Date(until).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  function trip(reason: string): never {
    tripped = true;
    const until = now() + COOLDOWN_MS;
    opts.cooldown?.set(until);
    log.error(
      `anti-bot verdict (${reason}); client disabled for this process, cooldown until ${untilLabel(until)}`,
    );
    throw new SheinRiskControlError(`${RISK_MESSAGE} Aguarde até ${untilLabel(until)}.`);
  }

  /**
   * First verdict with a fallback transport available: switch to it for the
   * rest of the process and let the caller retry the same request. Any other
   * verdict trips the breaker.
   */
  function verdict(reason: string): void {
    if (deps.fallbackFetch && !usingFallback) {
      usingFallback = true;
      log.warn(`anti-bot verdict (${reason}) on the primary transport; switching to the fallback transport`);
      return;
    }
    trip(reason);
  }

  function markAuthDead(message: string): never {
    authDead = true;
    throw new SheinAuthError(message);
  }

  function assertUsable(): void {
    if (tripped) throw new SheinRiskControlError(RISK_MESSAGE);
    const until = opts.cooldown?.get() ?? null;
    if (until !== null && until > now()) {
      throw new SheinRiskControlError(`${RISK_MESSAGE} Aguarde até ${untilLabel(until)}.`);
    }
  }

  async function gap(): Promise<void> {
    const wait = lastRequestAt + opts.minIntervalMs + random() * opts.jitterMs - now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = now();
  }

  /** Renewals arrive as Set-Cookie on any response; persist only real changes. */
  function persistCookies(response: FetchResponse, url: URL): void {
    const lines = response.headers.getSetCookie();
    if (lines.length === 0 || jar === null) return;
    const merged = mergeSetCookie(jar.cookies, lines, url.hostname, now());
    if (merged.skipped > 0) {
      log.warn(`${merged.skipped} Set-Cookie line(s) could not be parsed and were ignored`);
    }
    if (!merged.changed) return;
    jar = { ...jar, cookies: merged.cookies, savedAt: now() };
    try {
      session.save(jar);
      loadedMtime = session.mtimeMs();
    } catch (error) {
      log.warn(
        `could not persist renewed cookies: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function kindHeaders(kind: RequestKind): Record<string, string> {
    if (kind === "json") {
      return {
        accept: "application/json, text/plain, */*",
        "x-requested-with": "XMLHttpRequest",
        // The page every order call is made from; keeps the traffic shaped like the site's.
        referer: `${opts.baseUrl}/user/orders/list`,
      };
    }
    return { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
  }

  async function send(request: HttpRequest): Promise<HttpResponse> {
    assertUsable();
    const current = ensureSession();
    const url = new URL(request.url);
    const started = now();

    for (let attempt = 1; ; attempt += 1) {
      await gap();
      const headers: Record<string, string> = {
        "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
        ...kindHeaders(request.kind),
        ...request.headers,
        cookie: cookieHeader(current.cookies, url, now()),
        "user-agent": current.userAgent,
      };
      const fetchImpl = usingFallback && deps.fallbackFetch ? deps.fallbackFetch : primary;
      let response: FetchResponse;
      try {
        response = await fetchImpl(url.toString(), {
          method: request.method,
          headers,
          redirect: "manual",
          ...(request.body === undefined ? {} : { body: request.body }),
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
      } catch (error) {
        requests += 1;
        const reason = error instanceof Error ? error.message : String(error);
        if (attempt < MAX_ATTEMPTS) {
          log.warn(`${request.label} network error on attempt ${attempt}: ${reason}`);
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new SheinHttpError(0, `Falha de rede ao chamar a Shein em ${request.label}: ${reason}`);
      }
      requests += 1;
      const { status } = response;

      // A 3xx here is a verdict, not navigation: the site bounces an
      // unauthenticated caller to the login page and a flagged one to a challenge.
      if (status >= 300 && status < 400) {
        const location = response.headers.get("location") ?? "";
        if (LOGIN_PATH.test(location)) {
          markAuthDead("A Shein redirecionou para a página de login: a sessão expirou.");
        }
        if (CHALLENGE_PATH.test(location)) {
          verdict("redirect to a challenge");
          continue;
        }
        throw new SheinHttpError(
          status,
          `A Shein redirecionou ${request.label} para ${location || "(sem location)"}.`,
        );
      }

      persistCookies(response, url);

      if (isTransient(status) && attempt < MAX_ATTEMPTS) {
        log.warn(`${request.label} HTTP ${status} on attempt ${attempt}; backing off`);
        await sleep(backoffMs(attempt));
        continue;
      }

      if (status === 403) {
        verdict("HTTP 403");
        continue;
      }

      const body = await response.text();
      if (isChallengeHtml(body)) {
        verdict("challenge page");
        continue;
      }
      // Deliberately NO body-based login detection: every Shein page carries a
      // "Já sou cliente" link in its header, and matching it flagged the real
      // tracking page as a login page, killing the session for a whole run
      // (2026-09-07). A logged-out caller is redirected (302), which is caught
      // above; a 200 that is missing its SSR blob is the parser's business.

      if (isTransient(status)) {
        throw new SheinHttpError(
          status,
          `A Shein respondeu HTTP ${status} em ${request.label} após ${attempt} tentativas.`,
        );
      }
      if (status >= 400) {
        throw new SheinHttpError(status, `A Shein respondeu HTTP ${status} em ${request.label}.`);
      }

      // Never log headers: the cookie header is the account.
      log.debug(`${request.label} ${status} ${now() - started}ms`);
      return { status, headers: response.headers, body };
    }
  }

  return {
    serial,
    send,
    memberId: () => memberIdFromJar(ensureSession().cookies),
    userAgent: () => ensureSession().userAgent,
    cookies: () => ensureSession().cookies,
    trip,
    markAuthDead,
    cooldownUntil: () => {
      const until = opts.cooldown?.get() ?? null;
      return until !== null && until > now() ? until : null;
    },
    resetSession: () => {
      jar = null;
      loadedMtime = null;
      authDead = false;
    },
    state: () => ({
      tripped,
      authDead,
      requests,
      lastRequestAt: Number.isFinite(lastRequestAt) ? lastRequestAt : null,
      transport: usingFallback ? "fallback" : "primary",
    }),
  };
}
