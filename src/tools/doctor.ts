import { Type } from "@sinclair/typebox";
import { LOGIN_HINT } from "../core/errors.js";
import { MAX_PAGE_SIZE, STATUS_TYPE_ALL } from "../shein/api.js";
import { compactObject, defineTool } from "./define.js";

// The rediscovery checklist. Each layer is probed in order and reported by
// name, so a change on Shein's side is diagnosed in one call instead of guessed
// at from whichever tool happened to fail. Costs at most four requests.

type Check = { name: string; ok: boolean; detail: string };

/** Reported in this order, always, whatever path the run took. */
const LAYERS = ["session", "order_list", "order_archive", "order_detail", "order_track", "cache"] as const;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const doctor = defineTool({
  name: "doctor",
  description:
    "Diagnostica a instalação de ponta a ponta: sessão, listagem de pedidos, pedidos arquivados, " +
    "detalhe, rastreio e cache local. Diz qual camada quebrou quando a Shein muda alguma coisa — " +
    "rode antes de reportar um problema. Gasta no máximo 4 requisições.",
  readOnly: true,
  input: Type.Object({}),
  run: async (ctx0, ctx) => {
    void ctx0;
    const checks: Check[] = [];
    const push = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
    const has = (name: string) => checks.some((check) => check.name === name);

    let session = false;
    try {
      const data = ctx.session.load();
      session = data !== null;
      push(
        "session",
        session,
        session
          ? `${data?.cookies.length} cookie(s), salvos em ${new Date(data?.savedAt ?? 0).toISOString().slice(0, 10)}`
          : "nenhuma sessão salva",
      );
    } catch (error) {
      push("session", false, message(error));
    }

    let billno: string | null = null;
    if (session) {
      try {
        const page = await ctx.http.serial(() =>
          ctx.api.listOrders({ page: 1, limit: MAX_PAGE_SIZE, statusType: STATUS_TYPE_ALL }),
        );
        const orders = page.order_list ?? [];
        billno = orders[0]?.billno ?? null;
        push("order_list", orders.length > 0, `${orders.length} pedido(s) na página 1, ${page.sum ?? "?"} no total`);
      } catch (error) {
        push("order_list", false, message(error));
      }

      try {
        const archive = await ctx.http.serial(() => ctx.api.listArchivedOrders({ page: 1, limit: MAX_PAGE_SIZE }));
        const orders = archive.order_list ?? [];
        // An account with nothing older than a year answers an empty list, and
        // that is a healthy answer, not a failure.
        push("order_archive", true, `${orders.length} pedido(s) arquivado(s)`);
      } catch (error) {
        push("order_archive", false, message(error));
      }

      if (billno) {
        try {
          const detail = await ctx.http.serial(() => ctx.api.getOrderDetail(billno as string));
          const lines = (detail.sorted_price ?? []).filter((row) => String(row.show) === "1");
          const items = detail.orderGoodsList?.length ?? 0;
          push(
            "order_detail",
            items > 0 || lines.length > 0,
            `${items} item(ns), ${lines.length} linha(s) de preço`,
          );
        } catch (error) {
          push("order_detail", false, message(error));
        }

        try {
          const blob = await ctx.http.serial(() => ctx.api.getTracking(billno as string));
          const packages = Object.keys((blob as { packageMap?: Record<string, unknown> }).packageMap ?? {}).length;
          push("order_track", true, `bloco SSR lido, ${packages} pacote(s)`);
        } catch (error) {
          push("order_track", false, message(error));
        }
      }
    }

    for (const name of LAYERS) {
      if (name === "cache" || has(name)) continue;
      push(name, false, session ? "pulado: nenhum pedido na página 1" : "pulado: nenhuma sessão válida");
    }

    try {
      const stats = ctx.cache().stats();
      push(
        "cache",
        true,
        `${stats.orders} pedido(s), ${stats.items} item(ns), ${stats.packages} pacote(s); ` +
          `${stats.pendingDetails} sem detalhe; período ${stats.firstOrderDay ?? "-"} → ${stats.lastOrderDay ?? "-"}`,
      );
    } catch (error) {
      push("cache", false, message(error));
    }

    checks.sort((a, b) => LAYERS.indexOf(a.name as never) - LAYERS.indexOf(b.name as never));
    return compactObject({
      ok: checks.every((check) => check.ok),
      transport: ctx.http.state().transport,
      checks,
      hint: session ? undefined : LOGIN_HINT,
    });
  },
});
