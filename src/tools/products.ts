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
    "casar). Responde do cache, sem rede.",
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
    const prices = rows.map((row) => row.unit_cents).filter((cents) => cents > 0);
    return compactObject({
      goodsId,
      name: rows[0]?.name ?? null,
      total: rows.length,
      timesBought: new Set(rows.map((row) => row.billno)).size,
      unitsBought: rows.reduce((sum, row) => sum + row.quantity, 0),
      spent: toDecimal(rows.reduce((sum, row) => sum + row.total_cents, 0)),
      firstUnitPrice: prices.length > 0 ? toDecimal(prices[0] as number) : undefined,
      lastUnitPrice: prices.length > 0 ? toDecimal(prices[prices.length - 1] as number) : undefined,
      purchases: rows.map(purchaseOf),
    });
  },
});

export const listReturns = defineTool({
  name: "list_returns",
  description:
    "Lista os itens com devolução ou reembolso registrados no detalhe do pedido. A Shein não expõe " +
    "um histórico de devoluções que este projeto consiga ler, então aqui aparece só o que vem no " +
    "pedido — se estiver vazio, não significa que nunca houve devolução. Não usa a rede.",
  readOnly: true,
  input: Type.Object({
    from: dayField("Início do período, YYYY-MM-DD (inclusivo)"),
    to: dayField("Fim do período, YYYY-MM-DD (inclusivo)"),
    limit: limitField(200, 50),
  }),
  run: (args, ctx) => {
    const cache = ctx.cache();
    const rows = cache.listReturns({ from: args.from, to: args.to, limit: args.limit ?? 50 });
    return compactObject({
      total: rows.length,
      returns: rows.map((row) => ({ ...purchaseOf(row), refundStatus: row.refund_status })),
      returnableOrders: cache.countReturnable(),
      note:
        rows.length === 0
          ? "Nenhum item com devolução registrada no cache. O histórico de devoluções da Shein fica " +
            "em uma API que este projeto ainda não mapeou (docs/REDISCOVERY.md); veja `returnableOrders` " +
            "para os pedidos que ainda aceitam devolução."
          : undefined,
    });
  },
});
