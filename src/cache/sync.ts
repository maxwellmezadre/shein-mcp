import type { Ctx } from "../context.js";
import { SheinApiError, SheinAuthError, SheinRiskControlError } from "../core/errors.js";
import { normalizeOrder, normalizePackages, normalizeSummary } from "../domain/normalize.js";
import { MAX_PAGE_SIZE, STATUS_TYPE_ALL } from "../shein/api.js";
import type { RawOrderDetail, RawOrderListItem } from "../shein/types.js";

// Filling the cache is dozens of paced requests, so it happens in CHUNKS: the
// caller gets a budget, a cursor is persisted, and `done: false` means "call me
// again". Nothing is ever lost between chunks — each order is committed as it
// arrives.

/** Bump when a parser changes what it extracts; the next sync reparses the cache. */
export const PARSER_VERSION = 1;

export const META = {
  cursor: "sync.cursor",
  lastSync: "sync.last_completed_at",
  lastFullSync: "sync.last_full_completed_at",
  parserVersion: "sync.parser_version",
} as const;

export type SyncMode = "incremental" | "full" | "reparse";

export type SyncOptions = {
  mode?: SyncMode;
  /** Stop after this many requests and report a cursor (default 60). */
  maxRequests?: number;
  /** Also fetch the tracking of the orders that shipped. */
  withTracking?: boolean;
  /** Cap the list phase; 0 skips straight to the details (used by tests). */
  listPages?: number;
  onProgress?: (event: { phase: string; detail: string }) => void;
};

export type SyncResult = {
  mode: SyncMode;
  done: boolean;
  /** Orders seen for the first time. */
  listed: number;
  details: number;
  tracked: number;
  reparsed: number;
  errors: number;
  requests: number;
  hint: string;
};

type Cursor = {
  phase: "list" | "archive";
  page: number;
  /** Orders returned so far in this phase, compared against the page's `sum`. */
  seen: number;
  listDone: boolean;
};

const DEFAULT_MAX_REQUESTS = 60;
const emptyCursor = (): Cursor => ({ phase: "list", page: 1, seen: 0, listDone: false });

/** A finished order will never change again, so it is fetched once, ever. */
const isFinal = (status: string): boolean =>
  status === "delivered" || status === "cancelled" || status === "returned";

export async function runSyncChunk(ctx: Ctx, options: SyncOptions = {}): Promise<SyncResult> {
  const mode = options.mode ?? "incremental";
  const budgetTotal = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const cache = ctx.cache();
  const report = options.onProgress ?? (() => undefined);

  let budget = budgetTotal;
  let listed = 0;
  let details = 0;
  let tracked = 0;
  let reparsed = 0;
  let errors = 0;

  // A parser upgrade is repaired offline, before anything is fetched: the
  // stored payloads already hold everything the new parser needs.
  const storedVersion = cache.getMeta(META.parserVersion);
  if (mode === "reparse" || (storedVersion !== null && storedVersion !== String(PARSER_VERSION))) {
    reparsed = reparseAll(ctx);
    report({ phase: "reparse", detail: `${reparsed} pedido(s) reprocessado(s) sem rede` });
  }
  if (mode === "reparse") {
    cache.setMeta(META.parserVersion, String(PARSER_VERSION));
    return finish({ mode, done: true, listed, details, tracked, reparsed, errors, requests: budgetTotal - budget });
  }

  const cursor: Cursor =
    mode === "full"
      ? emptyCursor()
      : ((JSON.parse(cache.getMeta(META.cursor) ?? "null") as Cursor | null) ?? emptyCursor());
  if (mode === "full") cache.deleteMeta(META.cursor);

  const listPages = options.listPages ?? Number.POSITIVE_INFINITY;
  let pagesWalked = 0;

  // Phase A — the order list, then the archive. `status_type` is not sent as a
  // filter: the server ignores it (every tab answers the same page).
  while (!cursor.listDone && budget > 0 && pagesWalked < listPages) {
    const archive = cursor.phase === "archive";
    const page = await ctx.http.serial(() =>
      archive
        ? ctx.api.listArchivedOrders({ page: cursor.page, limit: MAX_PAGE_SIZE })
        : ctx.api.listOrders({ page: cursor.page, limit: MAX_PAGE_SIZE, statusType: STATUS_TYPE_ALL }),
    );
    budget -= 1;
    pagesWalked += 1;
    const orders = page.order_list ?? [];
    const fresh = storeSummaries(ctx, orders, archive);
    listed += fresh;
    cursor.seen += orders.length;
    report({ phase: archive ? "archive" : "list", detail: `página ${cursor.page}: ${orders.length} pedido(s), ${fresh} novo(s)` });

    // `sum` is the account total for the phase, so a full page is not the end:
    // the walk stops when the account is covered or a page comes back empty.
    const total = Number(page.sum ?? 0);
    const exhausted = orders.length === 0 || (total > 0 && cursor.seen >= total);
    // Incremental stops as soon as a page brings nothing new — and then the
    // archive cannot hold anything new either, since it is strictly older.
    const settled = mode === "incremental" && orders.length > 0 && fresh === 0;
    if (settled) {
      cursor.listDone = true;
    } else if (exhausted) {
      if (archive) cursor.listDone = true;
      else {
        cursor.phase = "archive";
        cursor.page = 1;
        cursor.seen = 0;
      }
    } else {
      cursor.page += 1;
    }
    cache.setMeta(META.cursor, JSON.stringify(cursor));
  }

  // Phase B — the details. The orders table is the queue, so a chunk that dies
  // mid-way simply leaves the rest queued.
  while (budget > 0) {
    const billno = cache.nextPendingDetail();
    if (!billno) break;
    let detail: RawOrderDetail;
    try {
      detail = await ctx.http.serial(() => ctx.api.getOrderDetail(billno));
      budget -= 1;
    } catch (error) {
      budget -= 1;
      // A session or anti-bot problem stops everything; a per-order failure
      // parks that order and the walk continues.
      if (error instanceof SheinAuthError || error instanceof SheinRiskControlError) throw error;
      if (error instanceof SheinApiError) {
        cache.markDetailError(billno, error.message);
        ctx.log.warn(`detail ${billno} skipped: ${error.message}`);
        errors += 1;
        continue;
      }
      throw error;
    }
    storeDetail(ctx, billno, detail);
    details += 1;
    report({ phase: "detail", detail: `${billno}: ${cache.countPendingDetails()} restante(s)` });
  }

  // Phase C — tracking, only when asked: it is one request per order.
  if (options.withTracking) {
    for (const summary of cache.listOrders({ limit: 500 })) {
      if (budget <= 0) break;
      if (summary.packageCount === 0 && summary.status !== "shipped") continue;
      if (cache.getPackages(summary.billno).length > 0 && isFinal(summary.status)) continue;
      try {
        const blob = await ctx.http.serial(() => ctx.api.getTracking(summary.billno));
        budget -= 1;
        cache.upsertPackages(summary.billno, normalizePackages(blob));
        tracked += 1;
      } catch (error) {
        budget -= 1;
        if (error instanceof SheinAuthError || error instanceof SheinRiskControlError) throw error;
        ctx.log.warn(`tracking ${summary.billno} skipped: ${error instanceof Error ? error.message : String(error)}`);
        errors += 1;
      }
    }
  }

  const pending = cache.countPendingDetails();
  const done = cursor.listDone && pending === 0;
  if (done) {
    cache.deleteMeta(META.cursor);
    cache.setMeta(META.lastSync, new Date(ctx.now()).toISOString());
    if (mode === "full") cache.setMeta(META.lastFullSync, new Date(ctx.now()).toISOString());
  }
  cache.setMeta(META.parserVersion, String(PARSER_VERSION));

  return finish({ mode, done, listed, details, tracked, reparsed, errors, requests: budgetTotal - budget, pending, cursor });
}

function finish(result: Omit<SyncResult, "hint"> & { pending?: number; cursor?: Cursor }): SyncResult {
  const { pending = 0, cursor, ...rest } = result;
  const hint = rest.done
    ? "Sincronização concluída."
    : `Faltam ${pending} detalhe(s)${cursor && !cursor.listDone ? ` e a listagem parou na página ${cursor.page}` : ""}. ` +
      "Chame `sync` de novo com os mesmos parâmetros para continuar.";
  return { ...rest, hint };
}

/** Stores the list rows, reporting how many were new. */
function storeSummaries(ctx: Ctx, orders: RawOrderListItem[], archived: boolean): number {
  const cache = ctx.cache();
  let fresh = 0;
  for (const raw of orders) {
    if (!raw.billno) continue;
    const known = cache.getSummary(raw.billno);
    cache.upsertSummary(normalizeSummary(raw, { archived }), JSON.stringify(raw));
    if (!known) fresh += 1;
  }
  return fresh;
}

function storeDetail(ctx: Ctx, billno: string, detail: RawOrderDetail): void {
  const cache = ctx.cache();
  const rawList = cache.rawList(billno);
  const summary = rawList ? (JSON.parse(rawList) as RawOrderListItem) : undefined;
  const archived = cache.getSummary(billno)?.archived ?? false;
  const order = normalizeOrder({ detail, summary, archived });
  cache.upsertDetail(order, JSON.stringify(detail), PARSER_VERSION);
}

/** Re-runs the current parser over every stored payload. No network. */
function reparseAll(ctx: Ctx): number {
  const cache = ctx.cache();
  let count = 0;
  for (const summary of cache.listOrders({ limit: 10_000 })) {
    const raw = cache.rawDetail(summary.billno);
    if (!raw) continue;
    storeDetail(ctx, summary.billno, JSON.parse(raw) as RawOrderDetail);
    count += 1;
  }
  return count;
}
