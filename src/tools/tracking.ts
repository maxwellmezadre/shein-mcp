import { Type } from "@sinclair/typebox";
import { normalizePackages } from "../domain/normalize.js";
import { compactObject, defineTool } from "./define.js";
import { billnoField } from "./fields.js";
import { presentPackage } from "./present.js";

// Tracking is the one thing that is never served from the cache: a parcel in
// transit changes between one question and the next.

export const trackOrder = defineTool({
  name: "track_order",
  description:
    "Rastreio de um pedido da Shein, sempre ao vivo (1 requisição): transportadora, código de rastreio " +
    "e a linha do tempo do pacote, do evento mais recente para o mais antigo. Vários pedidos da mesma " +
    "compra podem dividir um pacote. Um pedido que ainda não foi enviado responde sem pacotes.",
  readOnly: true,
  input: Type.Object({
    billno: billnoField,
    limit_events: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100, description: "Máximo de eventos por pacote (default todos)" }),
    ),
  }),
  run: async (args, ctx) => {
    const blob = await ctx.http.serial(() => ctx.api.getTracking(args.billno));
    const packages = normalizePackages(blob);
    // Worth storing even though the read is live: `list_orders` shows the count.
    ctx.cache().upsertPackages(args.billno, packages);
    const limit = args.limit_events;
    return compactObject({
      billno: args.billno,
      packageCount: packages.length,
      packages: packages.map((parcel) => {
        const presented = presentPackage(parcel);
        return limit ? { ...presented, events: presented.events.slice(0, limit) } : presented;
      }),
      note:
        packages.length === 0
          ? "A Shein não tem rastreio para este pedido: ele ainda não foi enviado (ou foi cancelado)."
          : undefined,
    });
  },
});
