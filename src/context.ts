import type { Database } from "bun:sqlite";
import { openCache } from "./cache/db.js";
import { type CacheRepo, createCacheRepo } from "./cache/repo.js";
import { type Config, loadConfig } from "./config.js";
import { type LaunchBrowser, createBrowserFetch, launchWithPlaywright } from "./core/browser-transport.js";
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
  /** Fake Chrome in tests; the real one is Playwright over the installed Chrome. */
  launchBrowser?: LaunchBrowser;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  session?: SessionStore;
  log?: Logger;
  /** `:memory:` in tests. */
  db?: Database;
};

export type Ctx = {
  config: Config;
  log: Logger;
  now: () => number;
  session: SessionStore;
  http: Http;
  api: SheinApi;
  /**
   * Memoised: the SQLite file is only opened (and migrated) on first use, so a
   * tool that never touches the cache never creates it.
   */
  cache: () => CacheRepo;
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

  // Transport: `fetch` is plain HTTP; `browser` runs every request inside a
  // headless Chrome; `auto` starts plain and switches to the browser for the
  // rest of the process on the first anti-bot verdict (see core/http.ts).
  let fetch = deps.fetch;
  let fallbackFetch = deps.fallbackFetch;
  let dispose = async (): Promise<void> => undefined;
  if (config.transport !== "fetch") {
    const browserFetch = createBrowserFetch({
      session,
      launch: deps.launchBrowser ?? launchWithPlaywright,
      baseUrl: config.baseUrl,
      profileDir: config.browserProfileDir,
      channel: config.browserChannel,
      log,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      now,
    });
    if (config.transport === "browser") fetch = browserFetch;
    else fallbackFetch = fallbackFetch ?? browserFetch;
    dispose = browserFetch.close;
  }

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
      ...(fetch ? { fetch } : {}),
      ...(fallbackFetch ? { fallbackFetch } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      now,
    },
  );

  const api = createSheinApi(http, { baseUrl: config.baseUrl, lang: config.lang });

  let db: Database | undefined;
  let repo: CacheRepo | undefined;
  const cache = (): CacheRepo => {
    if (!repo) {
      db = deps.db ?? openCache(config.dbPath);
      repo = createCacheRepo(db, now);
    }
    return repo;
  };

  const releaseBrowser = dispose;
  return {
    config,
    log,
    now,
    session,
    http,
    api,
    cache,
    dispose: async () => {
      await releaseBrowser();
      if (deps.db === undefined) db?.close();
      db = undefined;
      repo = undefined;
    },
  };
}

/** Convenience for the entry points: load the env config and wire everything. */
export const contextFromEnv = (): Ctx => createContext(loadConfig());
