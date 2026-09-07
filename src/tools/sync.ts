import { Type } from "@sinclair/typebox";
import { META, PARSER_VERSION, type SyncMode, runSyncChunk } from "../cache/sync.js";
import { toDecimal } from "../domain/money.js";
import { compactObject, defineTool } from "./define.js";

// Filling the cache is dozens of paced requests, so `sync` works in chunks: it
// spends a budget, commits everything it got, and says whether to call again.

export const sync = defineTool({
  name: "sync",
  description:
    "Baixa o histórico da Shein para o cache local, em blocos. Gasta no máximo `max_requests` " +
    "requisições por chamada e devolve `done: false` quando ainda falta; nesse caso chame de novo " +
    "com os mesmos parâmetros até `done: true`. `incremental` (padrão) para no primeiro trecho sem " +
    "novidade; `full` varre tudo de novo; `reparse` reprocessa o que já está salvo sem usar a rede. " +
    "Depois disso, list_orders, get_order e spending_summary respondem sem tocar na Shein.",
  readOnly: false,
  input: Type.Object({
    mode: Type.Optional(
      Type.Union([Type.Literal("incremental"), Type.Literal("full"), Type.Literal("reparse")], {
        description: "incremental (default) | full | reparse (sem rede)",
      }),
    ),
    max_requests: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 500, description: "Teto de requisições nesta chamada (default 60)" }),
    ),
    with_tracking: Type.Optional(
      Type.Boolean({ description: "Também busca o rastreio dos pedidos enviados (1 requisição por pedido)" }),
    ),
  }),
  run: async (args, ctx) => {
    const result = await runSyncChunk(ctx, {
      mode: (args.mode ?? "incremental") as SyncMode,
      ...(args.max_requests ? { maxRequests: args.max_requests } : {}),
      ...(args.with_tracking ? { withTracking: true } : {}),
      onProgress: (event) => ctx.log.info(`${event.phase}: ${event.detail}`),
    });
    const cache = ctx.cache();
    const stats = cache.stats();
    return compactObject({
      ...result,
      parserVersion: PARSER_VERSION,
      cache: {
        orders: stats.orders,
        items: stats.items,
        packages: stats.packages,
        pendingDetails: stats.pendingDetails,
        firstOrderDay: stats.firstOrderDay,
        lastOrderDay: stats.lastOrderDay,
        spentTotal: toDecimal(spentTotal(cache)),
      },
      lastSyncAt: cache.getMeta(META.lastSync) ?? undefined,
      lastFullSyncAt: cache.getMeta(META.lastFullSync) ?? undefined,
    });
  },
});

/** Cheap headline so the caller sees the sync actually landed something. */
function spentTotal(cache: ReturnType<import("../context.js").Ctx["cache"]>): number {
  return cache
    .listOrders({ limit: 10_000 })
    .filter((order) => order.status !== "unpaid" && order.status !== "cancelled")
    .reduce((total, order) => total + order.money.total, 0);
}
