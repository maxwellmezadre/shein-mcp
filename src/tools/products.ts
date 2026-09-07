import { Type } from "@sinclair/typebox";
import { toDecimal } from "../domain/money.js";
import { itemOf } from "../cache/rows.js";
import type { ProductPurchaseRow, ProductRow } from "../cache/repo.js";
import { compactObject, defineTool } from "./define.js";
import { dayField, limitField } from "./fields.js";

// Everything here answers from the cache: no network, ever. They are the
// questions a purchase history is actually for — what did I buy, how often,
// and did the price move.

const SYNC_HINT = "O cache está vazio. Rode `sync` (ou `shein sync`) para baixar o histórico.";

const purchaseOf = (row: ProductPurchaseRow) => {
  const item = itemOf(row);
  return compactObject({
    billno: row.billno,
    placedAt: row.placed_at,
    status: row.status,
    name: item.name,
    attrs: item.attrs ?? undefined,
    quantity: item.quantity,
    unitPrice: toDecimal(item.unitPrice),
    totalPrice: toDecimal(item.totalPrice),
    store: item.store?.name ?? undefined,
  });
};

export const searchProducts = defineTool({
  name: "search_products",
  description:
    "Busca entre os produtos que o usuário JÁ COMPROU na Shein (não é busca no catálogo). Ignora " +
    "acentos e maiúsculas e olha nome, cor/tamanho e loja. Não usa a rede. Use para 'quando comprei " +
    "aquele conjunto', 'quanto paguei na calcinha', 'já comprei isso antes?'.",
  readOnly: true,
  input: Type.Object({
    query: Type.String({ minLength: 1, description: "Palavras do produto, como o usuário lembra" }),
    limit: limitField(200, 20),
  }),
  run: (args, ctx) => {
    const cache = ctx.cache();
    const rows = cache.searchItems(args.query, args.limit ?? 20);
    return compactObject({
      query: args.query,
      total: rows.length,
      items: rows.map((row) => {
        const item = itemOf(row);
        return compactObject({
          billno: row.billno,
          goodsId: item.goodsId,
          name: item.name,
          attrs: item.attrs ?? undefined,
          quantity: item.quantity,
          unitPrice: toDecimal(item.unitPrice),
          totalPrice: toDecimal(item.totalPrice),
          store: item.store?.name ?? undefined,
        });
      }),
      note: cache.countOrders() === 0 ? SYNC_HINT : undefined,
    });
  },
});

const productOf = (row: ProductRow) =>
  compactObject({
    goodsId: row.goods_id,
    name: row.name,
    store: row.store_name ?? undefined,
    catId: row.cat_id ?? undefined,
    orders: row.orders,
    quantity: row.quantity,
    spent: toDecimal(row.spent_cents),
    minUnitPrice: toDecimal(row.min_unit_cents),
    maxUnitPrice: toDecimal(row.max_unit_cents),
    firstBoughtOn: row.first_day,
    lastBoughtOn: row.last_day,
  });

export const listProducts = defineTool({
  name: "list_products",
  description:
    "Lista os produtos comprados agregados por produto: quantas vezes, quantas unidades, quanto foi " +
    "gasto no total e o preço unitário mínimo e máximo. Do maior gasto para o menor, sem usar a rede. " +
    "Pedidos não pagos e cancelados ficam de fora.",
  readOnly: true,
  input: Type.Object({
    store: Type.Optional(Type.String({ description: "Nome exato da loja" })),
    category: Type.Optional(Type.String({ description: "cat_id da Shein" })),
    from: dayField("Início do período, YYYY-MM-DD (inclusivo)"),
    to: dayField("Fim do período, YYYY-MM-DD (inclusivo)"),
    limit: limitField(500, 50),
  }),
  run: (args, ctx) => {
    const cache = ctx.cache();
    const rows = cache.listProducts({
      store: args.store,
      catId: args.category,
      from: args.from,
      to: args.to,
      limit: args.limit ?? 50,
    });
    return compactObject({
      total: rows.length,
      products: rows.map(productOf),
      note: cache.countOrders() === 0 ? SYNC_HINT : undefined,
    });
  },
});

export const productHistory = defineTool({
  name: "product_history",
  description:
    "Todas as compras de um produto, da mais antiga para a mais nova, com a evolução do preço " +
    "unitário. Aceita o goods_id ou palavras do nome (nesse caso usa o produto mais comprado que " +
    "casar). Pedidos não pagos e cancelados aparecem na lista, mas não entram no total gasto. " +
    "Responde do cache, sem rede.",
  readOnly: true,
  input: Type.Object({
    product: Type.String({ minLength: 1, description: "goods_id da Shein ou palavras do nome do produto" }),
  }),
  run: (args, ctx) => {
    const cache = ctx.cache();
    const query = args.product.trim();
    // A bare id is the precise path; anything else is resolved by search, and
    // the tool says which product it settled on.
    let goodsId = /^\d+$/.test(query) ? query : null;
    if (goodsId === null) {
      const found = cache.searchItems(query, 50).find((row) => row.goods_id);
      goodsId = found?.goods_id ?? null;
    }
    if (goodsId === null) {
      return { product: query, total: 0, note: `Nenhum produto comprado casa com "${query}".` };
    }
    const rows = cache.productHistory(goodsId);
    // An order that was never paid (or was cancelled) is still worth showing —
    // the user did try to buy it — but it is not money they spent.
    const bought = rows.filter((row) => row.status !== "unpaid" && row.status !== "cancelled");
    const prices = bought.map((row) => row.unit_cents).filter((cents) => cents > 0);
    return compactObject({
      goodsId,
      name: rows[0]?.name ?? null,
      total: rows.length,
      timesBought: new Set(bought.map((row) => row.billno)).size,
      unitsBought: bought.reduce((sum, row) => sum + row.quantity, 0),
      spent: toDecimal(bought.reduce((sum, row) => sum + row.total_cents, 0)),
      attempts: rows.length - bought.length || undefined,
      firstUnitPrice: prices.length > 0 ? toDecimal(prices[0] as number) : undefined,
      lastUnitPrice: prices.length > 0 ? toDecimal(prices[prices.length - 1] as number) : undefined,
      purchases: rows.map(purchaseOf),
    });
  },
});

/** The "Devolução/Reembolso" tab of the orders page (`orderStatusList[].id`). */
const RETURNS_TAB = 4;

export const listReturns = defineTool({
  name: "list_returns",
  description:
    "Lista as devoluções e reembolsos: por padrão os itens que o detalhe do pedido marca, do cache e " +
    "sem rede. Com verify=true gasta 1 requisição e lê a aba 'Devolução/Reembolso' do próprio site, " +
    "que é a única superfície que filtra de verdade; é assim que dá para afirmar que não houve " +
    "nenhuma devolução, em vez de só não ter achado.",
  readOnly: true,
  input: Type.Object({
    verify: Type.Optional(
      Type.Boolean({ description: "Confere na aba de devoluções do site (1 requisição)" }),
    ),
    from: dayField("Início do período, YYYY-MM-DD (inclusivo)"),
    to: dayField("Fim do período, YYYY-MM-DD (inclusivo)"),
    limit: limitField(200, 50),
  }),
  run: async (args, ctx) => {
    const cache = ctx.cache();
    const rows = cache.listReturns({ from: args.from, to: args.to, limit: args.limit ?? 50 });
    const fromCache = {
      total: rows.length,
      returns: rows.map((row) => ({ ...purchaseOf(row), refundStatus: row.refund_status })),
      returnableOrders: cache.countReturnable(),
    };

    if (!args.verify) {
      return compactObject({
        ...fromCache,
        note:
          rows.length === 0
            ? "Nenhuma devolução registrada no cache. Isso é o que o detalhe dos pedidos carrega; " +
              "para conferir na aba de devoluções do próprio site, chame de novo com verify=true."
            : undefined,
      });
    }

    // The JSON endpoint ignores `status_type`; only the SSR page filters.
    const page = await ctx.http.serial(() => ctx.api.listOrdersPage({ page: 1, statusType: RETURNS_TAB }));
    const orders = page.order_list ?? [];
    const siteReturns = Number(page.sum ?? orders.length);
    return compactObject({
      ...fromCache,
      siteReturns,
      siteOrders: orders.map((order) => ({
        billno: order.billno,
        placedAt: order.addTime,
        total: order.totalPrice,
      })),
      note:
        siteReturns === 0
          ? "Nenhuma devolução: a aba 'Devolução/Reembolso' do site está vazia para esta conta."
          : `A Shein lista ${siteReturns} pedido(s) em devolução/reembolso.`,
    });
  },
});
