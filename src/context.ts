import { type Config, loadConfig } from "./config.js";
import { type FetchLike, type Http, createHttp } from "./core/http.js";
import { type Logger, createLogger } from "./core/logger.js";
import { type SessionStore, createSessionStore } from "./session/store.js";
import { type SheinApi, createSheinApi } from "./shein/api.js";

// Explicit DI container. Everything a tool needs hangs off `Ctx`, and every
// temporal/IO collaborator can be replaced in tests. No singletons, no
// framework: `createContext(loadConfig())` is the whole wiring.

export type ContextDeps = {
  fetch?: FetchLike;
  fallbackFetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  session?: SessionStore;
  log?: Logger;
};

export type Ctx = {
  config: Config;
  log: Logger;
  now: () => number;
  session: SessionStore;
  http: Http;
  api: SheinApi;
  /** Releases what was opened (browser, database). Safe to call more than once. */
  dispose: () => Promise<void>;
};

export function createContext(config: Config, deps: ContextDeps = {}): Ctx {
  const now = deps.now ?? (() => Date.now());
  const session = deps.session ?? createSessionStore(config);
  // The logger reads the cookie values through a provider, so redaction keeps
  // working after the site rotates a cookie mid-session.
  const log =
    deps.log ??
    createLogger({
      ...(config.logFile ? { logFile: config.logFile } : {}),
      secrets: () => session.peekSecrets(),
    });

  // ponytail: the browser transport (SHEIN_TRANSPORT=browser|auto) is wired
  // here in a later step; until then every transport is plain fetch.
  const http = createHttp(
    {
      session,
      baseUrl: config.baseUrl,
      minIntervalMs: config.minIntervalMs,
      jitterMs: config.jitterMs,
      timeoutMs: config.httpTimeoutMs,
      log,
    },
    {
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.fallbackFetch ? { fallbackFetch: deps.fallbackFetch } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      now,
    },
  );

  const api = createSheinApi(http, { baseUrl: config.baseUrl, lang: config.lang });

  return {
    config,
    log,
    now,
    session,
    http,
    api,
    dispose: async () => undefined,
  };
}

/** Convenience for the entry points: load the env config and wire everything. */
export const contextFromEnv = (): Ctx => createContext(loadConfig());
