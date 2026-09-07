import { Type } from "@sinclair/typebox";
import type { SpendingGroup } from "../cache/repo.js";
import { toDecimal } from "../domain/money.js";
import { compactObject, defineTool } from "./define.js";
import { dayField } from "./fields.js";

// The question a purchase history exists to answer. Everything is read from
// the cache, in one SQL statement, with money in integer cents so the rows
// really do add up to the total.

const GROUPS = ["month", "year", "store", "payment", "breakdown"] as const;

const NOTES: Record<SpendingGroup, string> = {
  month: "Totais por mês, pelo que foi efetivamente pago. Pedidos não pagos e cancelados ficam de fora.",
  year: "Totais por ano, pelo que foi efetivamente pago. Pedidos não pagos e cancelados ficam de fora.",
  store:
    "Por loja, somando os itens de cada loja; um pedido com duas lojas aparece nas duas, então a " +
    "soma das linhas é o total gasto em itens, sem frete, imposto nem taxa de parcelamento.",
  payment: "Por meio de pagamento, pelo total do pedido.",
  breakdown:
    "Por componente do preço (as linhas que a própria Shein mostra e que somam o total): produtos, " +
    "frete, imposto, taxa de parcelamento, seguros.",
};

export const spendingSummary = defineTool({
  name: "spending_summary",
  description:
    "Quanto o usuário gastou na Shein, agrupado por mês, ano, loja, meio de pagamento ou componente " +
    "do preço. Responde do cache, sem rede. Pedidos não pagos e cancelados nunca entram na conta. " +
    "Use para 'quanto gastei este ano', 'quanto foi de frete', 'qual loja levou mais dinheiro'.",
  readOnly: true,
  input: Type.Object({
    group_by: Type.Optional(
      Type.Union(
        GROUPS.map((group) => Type.Literal(group)),
        { description: "month (default) | year | store | payment | breakdown" },
      ),
    ),
    from: dayField("Início do período, YYYY-MM-DD (inclusivo)"),
    to: dayField("Fim do período, YYYY-MM-DD (inclusivo)"),
  }),
  run: (args, ctx) => {
    const cache = ctx.cache();
    const group = (args.group_by ?? "month") as SpendingGroup;
    const filters = { from: args.from, to: args.to };
    const rows = cache.spendingBy(group, filters);
    const spent = cache.spentTotal(filters);
    // For `store` and `breakdown` the rows are parts of the orders, so their
    // own sum is the honest grand total to compare them against.
    const partial = group === "store" || group === "breakdown";
    const rowsTotal = rows.reduce((total, row) => total + row.total_cents, 0);
    return compactObject({
      groupBy: group,
      currency: "BRL",
      orders: spent.orders,
      grandTotal: toDecimal(partial ? rowsTotal : spent.cents),
      ordersTotal: partial ? toDecimal(spent.cents) : undefined,
      rows: rows.map((row) => ({
        key: row.key,
        total: toDecimal(row.total_cents),
        orders: row.orders,
      })),
      note: NOTES[group],
      // The parts never cover the whole when an order has no breakdown stored
      // (an archived order answers its detail with an empty shell), or when a
      // component is not an item. Saying so beats letting a reader infer it.
      gapNote:
        partial && rowsTotal !== spent.cents
          ? `A soma das linhas (${toDecimal(rowsTotal)}) é menor que o total dos pedidos ` +
            `(${toDecimal(spent.cents)}): a diferença são pedidos sem esse detalhe salvo ` +
            "(arquivados) e componentes que não são itens."
          : undefined,
      hint: spent.orders === 0 ? "O cache está vazio. Rode `sync` para baixar o histórico." : undefined,
    });
  },
});
