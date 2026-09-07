import { Type } from "@sinclair/typebox";

// Schema fragments shared by several tools, so a description is written once.

export const compactField = Type.Optional(
  Type.Boolean({
    description: "Devolve apenas os campos essenciais, para economizar contexto (default SHEIN_COMPACT)",
  }),
);

export const dayField = (description: string) =>
  Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description }));

export const limitField = (max: number, fallback: number) =>
  Type.Optional(
    Type.Integer({ minimum: 1, maximum: max, description: `Máximo de itens (default ${fallback})` }),
  );

export const offsetField = Type.Optional(
  Type.Integer({ minimum: 0, description: "Itens a pular (paginação)" }),
);

/** `billno`, the order number (e.g. `GSH1…`), as it appears in `list_orders`. */
export const billnoField = Type.String({
  pattern: "^[A-Za-z0-9]{8,32}$",
  description: "Número do pedido na Shein (billno, ex.: GSH1…), como aparece em `list_orders`",
});
