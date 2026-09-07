import { ParseError, SheinApiError } from "../core/errors.js";
import type { Http, RequestKind } from "../core/http.js";
import { extractTrackSsrData } from "./gbdata.js";
import type { BffEnvelope, RawOrderDetail, RawOrderListPage, RawTrackSsrData } from "./types.js";

// Typed wrappers over the endpoints catalogued in task/PRD.md ("Descobertas").
// Thin on purpose: paths, params and envelope unwrapping — no normalization.

/** Constant on every JSON call the site makes; part of the URL, not a header. */
export const API_VER = "1.1.8";

/**
 * `code` values the bff-api answers to a logged-out caller. Provisional until
 * the unauthenticated probe of the capture script (step 009) confirms them;
 * the HTML pages already redirect to the login page, which http.ts handles.
 */
export const LOGGED_OUT_CODES: ReadonlySet<string> = new Set(["300206", "100101"]);

export const ENDPOINTS = {
  list: "/bff-api/order/list",
  archive: "/bff-api/order/get_order_archive_list",
  detail: "/bff-api/order/get_order_detail",
  /** HTML page whose SSR blob carries the tracking timeline. */
  track: "/orders/track",
} as const;

/** Tabs of the orders page (`orderStatusList[].id`); 0 = every order. */
export const STATUS_TYPE_ALL = 0;

export type QueryValue = string | number | boolean | undefined;

export type ListOrdersParams = { page: number; limit: number; statusType: number };
export type PageParams = { page: number; limit: number };

export type SheinApi = {
  listOrders(params: ListOrdersParams): Promise<RawOrderListPage>;
  /** Orders older than the window the main list shows (about a year). */
  listArchivedOrders(params: PageParams): Promise<RawOrderListPage>;
  getOrderDetail(billno: string): Promise<RawOrderDetail>;
  /** The tracking page's SSR blob; one HTML request. */
  getTracking(billno: string): Promise<RawTrackSsrData>;
  /** Escape hatch: the raw envelope of any GET under the base url. */
  getRaw(path: string, query?: Record<string, QueryValue>, kind?: RequestKind): Promise<unknown>;
};

export type SheinApiOptions = { baseUrl: string; lang: string };

function buildUrl(base: string, path: string, query: Record<string, QueryValue>): string {
  const url = new URL(path, `${base}/`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function parseEnvelope(body: string, path: string): BffEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ParseError(`A resposta de ${path} não é JSON (a Shein mudou o endpoint ou serviu uma página).`);
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { code?: unknown }).code !== "string") {
    throw new ParseError(`A resposta de ${path} não tem o envelope {code, msg, info} esperado.`);
  }
  return parsed as BffEnvelope;
}

export function createSheinApi(http: Http, opts: SheinApiOptions): SheinApi {
  const common = { _ver: API_VER, _lang: opts.lang };

  async function callJson<T>(path: string, query: Record<string, QueryValue>, label: string): Promise<T> {
    const response = await http.send({
      url: buildUrl(opts.baseUrl, path, { ...common, ...query }),
      method: "GET",
      kind: "json",
      label,
    });
    const envelope = parseEnvelope(response.body, path);
    if (LOGGED_OUT_CODES.has(envelope.code)) {
      http.markAuthDead(`A Shein respondeu ${envelope.code} em ${path}: a sessão expirou.`);
    }
    if (envelope.code !== "0") {
      throw new SheinApiError(envelope.code, envelope.msg ?? "", path);
    }
    if (envelope.info === null || envelope.info === undefined) {
      throw new ParseError(`A Shein respondeu code 0 sem \`info\` em ${path}.`);
    }
    return envelope.info as T;
  }

  return {
    listOrders: ({ page, limit, statusType }) =>
      callJson<RawOrderListPage>(ENDPOINTS.list, { page, limit, status_type: statusType }, "order.list"),

    listArchivedOrders: ({ page, limit }) =>
      callJson<RawOrderListPage>(ENDPOINTS.archive, { page, limit }, "order.archive"),

    getOrderDetail: (billno) => callJson<RawOrderDetail>(ENDPOINTS.detail, { billno }, "order.detail"),

    async getTracking(billno) {
      const response = await http.send({
        url: buildUrl(opts.baseUrl, ENDPOINTS.track, { billno }),
        method: "GET",
        kind: "html",
        label: "orders.track",
      });
      const data = extractTrackSsrData(response.body);
      if (!data) {
        throw new ParseError("A página de rastreio veio sem o bloco `gbOrdersTrackSsrData`.");
      }
      return data as RawTrackSsrData;
    },

    async getRaw(path, query = {}, kind = "json") {
      const response = await http.send({
        url: buildUrl(opts.baseUrl, path, kind === "json" ? { ...common, ...query } : query),
        method: "GET",
        kind,
        label: "raw",
      });
      return kind === "json" ? parseEnvelope(response.body, path) : response.body;
    },
  };
}
