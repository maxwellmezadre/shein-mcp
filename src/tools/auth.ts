import { Type } from "@sinclair/typebox";
import { LOGIN_HINT, SheinAuthError, SheinRiskControlError } from "../core/errors.js";
import { memberIdFromJar } from "../session/jar.js";
import { STATUS_TYPE_ALL } from "../shein/api.js";
import { compactObject, defineTool } from "./define.js";

// Session diagnostics. Free by default: it reads the local session file and
// says nothing that could not be derived from it. `verify: true` spends exactly
// one request — the first page of the order list, limited to one order, which
// is the cheapest call that actually rejects a dead session.

export type AuthStatus = {
  loggedIn: boolean;
  verified?: boolean;
  error?: string;
  sessionFile: string;
  cookieCount: number;
  httpOnlyCount: number;
  savedAt: string | null;
  ageDays: number | null;
  soonestExpiry: string | null;
  memberId: string | null;
  /** Configured transport (`auto|fetch|browser`) and the one serving requests now. */
  transport: string;
  activeTransport: "primary" | "fallback";
  breaker: "ok" | "tripped";
  cooldownUntil: string | null;
  /** Orders in the account (`sum` of the main list) — proof the session is live. */
  totalOrders?: number;
  firstPageOrders?: number;
  hint?: string;
};

export const authStatus = defineTool({
  name: "auth_status",
  description:
    "Diz se há uma sessão da Shein salva e o que ela cobre (memberId, idade, validade dos cookies, " +
    "transporte, bloqueio anti-bot). Não usa a rede por padrão. Com verify=true gasta 1 requisição " +
    "para confirmar que a Shein ainda aceita a sessão. Comece por aqui quando outra tool reclamar de sessão.",
  readOnly: true,
  input: Type.Object({
    verify: Type.Optional(
      Type.Boolean({ description: "Também faz 1 chamada à Shein para confirmar que a sessão é aceita" }),
    ),
  }),
  run: async (args, ctx): Promise<AuthStatus> => {
    const { session, http, config } = ctx;
    let data: ReturnType<typeof session.load> = null;
    let loadError: string | undefined;
    try {
      data = session.load();
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }

    const cookies = data?.cookies ?? [];
    const expiries = cookies.filter((cookie) => cookie.expires > 0).map((cookie) => cookie.expires);
    const cooldown = http.cooldownUntil();
    const state = http.state();
    const base: AuthStatus = {
      loggedIn: data !== null,
      sessionFile: config.sessionPath,
      cookieCount: cookies.length,
      httpOnlyCount: cookies.filter((cookie) => cookie.httpOnly).length,
      savedAt: data ? new Date(data.savedAt).toISOString() : null,
      ageDays: data ? Math.floor((ctx.now() - data.savedAt) / 86_400_000) : null,
      soonestExpiry: expiries.length > 0 ? new Date(Math.min(...expiries) * 1000).toISOString() : null,
      memberId: memberIdFromJar(cookies),
      transport: config.transport,
      activeTransport: state.transport,
      breaker: state.tripped ? "tripped" : "ok",
      cooldownUntil: cooldown === null ? null : new Date(cooldown).toISOString(),
    };

    if (loadError) return compactObject({ ...base, loggedIn: false, error: loadError });
    if (data === null) return compactObject({ ...base, hint: `Nenhuma sessão salva. ${LOGIN_HINT}` });
    if (!args.verify) return compactObject(base);

    try {
      const page = await http.serial(() =>
        ctx.api.listOrders({ page: 1, limit: 1, statusType: STATUS_TYPE_ALL }),
      );
      return compactObject({
        ...base,
        verified: true,
        totalOrders: page.sum === undefined ? undefined : Number(page.sum),
        firstPageOrders: page.order_list?.length ?? 0,
      });
    } catch (error) {
      // An expired session or an anti-bot verdict is a *status*, not a crash:
      // this tool exists to report exactly that.
      if (error instanceof SheinAuthError || error instanceof SheinRiskControlError) {
        const after = http.state();
        return compactObject({
          ...base,
          loggedIn: false,
          verified: false,
          activeTransport: after.transport,
          breaker: after.tripped ? "tripped" : base.breaker,
          error: error.message,
        });
      }
      throw error;
    }
  },
});
