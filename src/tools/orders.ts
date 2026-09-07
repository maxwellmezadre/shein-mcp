import { Type } from "@sinclair/typebox";
import { PARSER_VERSION } from "../cache/sync.js";
import { normalizeOrder } from "../domain/normalize.js";
import type { OrderStatus } from "../domain/status.js";
import { ORDER_STATUSES } from "../domain/status.js";
import type { RawOrderDetail, RawOrderListItem } from "../shein/types.js";
import { compactObject, defineTool } from "./define.js";
import { billnoField, compactField, dayField, limitField, offsetField } from "./fields.js";
import { presentOrder, presentSummary } from "./present.js";

// Reading tools. They answer from the cache, so asking about the history costs
// nothing; `get_order` is the one exception, and only for an order the cache
// has never seen.

const SYNC_HINT = "O cache está vazio. Rode `sync` (ou `shein sync`) para baixar o histórico.";

const statusField = Type.Optional(
  Type.Union(
    ORDER_STATUSES.map((status) => Type.Literal(status)),
    { description: "Filtra por situação do pedido" },
  ),
);

export const listOrders = defineTool({
  name: "list_orders",
  description:
    "Lista os pedidos da Shein já baixados para o cache, do mais novo para o mais antigo, com filtros " +
    "por situação, período, loja e checkout. Não usa a rede: rode `sync` antes se o cache estiver vazio. " +
    "Use para 'meus últimos pedidos', 'o que comprei em agosto', 'pedidos da loja X'.",
  readOnly: true,
  input: Type.Object({
    status: statusField,
    from: dayField("Início do período, YYYY-MM-DD (inclusivo)"),
    to: dayField("Fim do período, YYYY-MM-DD (inclusivo)"),
    store: Type.Optional(Type.String({ description: "Nome exato da loja, como aparece nos itens" })),
    checkout_id: Type.Optional(
      Type.String({ description: "Agrupa os pedidos de uma mesma compra (relation billno)" }),
    ),
    archived: Type.Optional(Type.Boolean({ description: "Só pedidos arquivados (mais de um ano)" })),
    limit: limitField(200, 20),
    offset: offsetField,
    compact: compactField,
  }),
  run: (args, ctx) => {
    const cache = ctx.cache();
    const limit = args.limit ?? 20;
    const orders = cache.listOrders({
      status: args.status as OrderStatus | undefined,
      from: args.from,
      to: args.to,
      store: args.store,
      checkoutId: args.checkout_id,
      archived: args.archived,
      limit,
      offset: args.offset ?? 0,
    });
    const total = cache.countOrders();
    return compactObject({
      total,
      returned: orders.length,
      hasMore: (args.offset ?? 0) + orders.length < total,
      orders: orders.map((order) => presentSummary(order, { compact: args.compact })),
      note: total === 0 ? SYNC_HINT : undefined,
      pendingDetails: cache.countPendingDetails() || undefined,
    });
  },
});

export const getOrder = defineTool({
  name: "get_order",
  description:
    "Detalhe completo de um pedido da Shein: itens, preços, o breakdown que soma o total (subtotal, " +
    "frete, imposto, taxa de parcelamento), pagamento, pacotes e situação. Responde do cache; se o " +
    "pedido não estiver lá, gasta 1 requisição e guarda o resultado. O endereço de entrega só vem com " +
    "include_address=true.",
  readOnly: true,
  input: Type.Object({
    billno: billnoField,
    include_address: Type.Optional(
      Type.Boolean({ description: "Inclui o endereço de entrega (dado pessoal; default false)" }),
    ),
    compact: compactField,
  }),
  run: async (args, ctx) => {
    const cache = ctx.cache();
    const present = (source: "cache" | "live", order: Parameters<typeof presentOrder>[0]) =>
      compactObject({
        source,
        ...presentOrder(order, { compact: args.compact, includeAddress: args.include_address }),
        packages: cache.getPackages(order.billno).length || undefined,
      });

    const stored = cache.getOrder(args.billno);
    // A row that only came from the list has no items yet: fetch the detail.
    if (stored && stored.items.length > 0) {
      if (!args.include_address) return present("cache", stored);
      // The address is never projected into a column — it is the buyer's home.
      // The raw payload is there, though, so asking for it costs no request.
      const raw = cache.rawDetail(args.billno);
      if (!raw) return present("cache", stored);
      const rawList = cache.rawList(args.billno);
      return present(
        "cache",
        normalizeOrder({
          detail: JSON.parse(raw) as RawOrderDetail,
          summary: rawList ? (JSON.parse(rawList) as RawOrderListItem) : undefined,
          archived: stored.archived,
          includeAddress: true,
        }),
      );
    }

    const detail = await ctx.http.serial(() => ctx.api.getOrderDetail(args.billno));
    const rawList = cache.rawList(args.billno);
    const order = normalizeOrder({
      detail,
      summary: rawList ? (JSON.parse(rawList) as RawOrderListItem) : undefined,
      archived: stored?.archived ?? false,
      includeAddress: true,
    });
    cache.upsertDetail(order, JSON.stringify(detail), PARSER_VERSION);
    return present("live", order);
  },
});
