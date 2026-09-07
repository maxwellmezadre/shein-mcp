import { ParseError, SheinApiError } from "../core/errors.js";
import type { Http, RequestKind } from "../core/http.js";
import { extractGbRawData, extractTrackSsrData } from "./gbdata.js";
import type { BffEnvelope, RawOrderDetail, RawOrderListPage, RawTrackSsrData } from "./types.js";

// Typed wrappers over the endpoints catalogued in task/PRD.md ("Descobertas").
// Thin on purpose: paths, params and envelope unwrapping — no normalization.

/** Constant on every JSON call the site makes; part of the URL, not a header. */
export const API_VER = "1.1.8";

/**
 * What a logged-out caller gets from the bff-api (confirmed 2026-09-07 with a
 * bogus session): `{"code":"00101001","msg":"Server error, please try again.","info":{}}`.
 * The SAME code comes back for a wrong parameter or method, so it is NOT proof
 * of an expired session: it never kills the jar, it only carries a hint, and
 * `auth_status` is the tool that decides. Our own wrappers always send valid
 * parameters, so in practice the hint is right.
 */
export const SESSION_SUSPECT_CODES: ReadonlySet<string> = new Set(["00101001"]);

/** The list endpoints cap `limit` at 20 whatever is asked (limit=50 returns 20). */
export const MAX_PAGE_SIZE = 20;

export const ENDPOINTS = {
  list: "/bff-api/order/list",
  archive: "/bff-api/order/get_order_archive_list",
  detail: "/bff-api/order/get_order_detail",
  /** HTML page whose SSR blob carries the tracking timeline. */
  track: "/orders/track",
  /** HTML page whose SSR blob is the only surface that honours `status_type`. */
  page: "/user/orders/list",
} as const;

/**
 * Tabs of the orders page (`orderStatusList[].id`); 0 = every order.
 * The server IGNORES it: every tab answers byte-for-byte the same page
 * (verified 2026-09-07), so filtering by status happens locally, on the cache.
 */
export const STATUS_TYPE_ALL = 0;

export type QueryValue = string | number | boolean | undefined;

export type ListOrdersParams = { page: number; limit: number; statusType: number };
export type PageParams = { page: number; limit: number };

export type SheinApi = {
  listOrders(params: ListOrdersParams): Promise<RawOrderListPage>;
  /**
   * The same listing, read from the SSR page instead of the JSON API. Costs a
   * ~1 MB download, and is the ONLY way to filter by tab: the JSON endpoint
   * ignores `status_type` and answers the same page for every value.
   */
  listOrdersPage(params: { page: number; statusType: number }): Promise<RawOrderListPage>;
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
    if (envelope.code !== "0") {
      throw new SheinApiError(
        envelope.code,
        envelope.msg ?? "",
        path,
        SESSION_SUSPECT_CODES.has(envelope.code)
          ? "pode ser sessão expirada (é o que a Shein responde a quem não está logado) ou parâmetro errado: rode `shein status --verify`"
          : undefined,
      );
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

    async listOrdersPage({ page, statusType }) {
      const response = await http.send({
        url: buildUrl(opts.baseUrl, ENDPOINTS.page, { page, status_type: statusType }),
        method: "GET",
        kind: "html",
        label: "orders.page",
      });
      const data = extractGbRawData(response.body);
      if (!data) throw new ParseError("A página de pedidos veio sem o bloco `gbRawData`.");
      return data as RawOrderListPage;
    },

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
