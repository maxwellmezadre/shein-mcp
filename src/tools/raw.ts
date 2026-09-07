import { Type } from "@sinclair/typebox";
import { defineTool } from "./define.js";

// Escape hatch for rediscovery when Shein changes something (see
// docs/REDISCOVERY.md). It rides the same cookies, rate limit and breaker as
// every other call, and it is fenced in two ways:
//   - the path must be one of the order surfaces (JSON bff-api or SSR pages);
//   - anything that could write to the account is refused outright.

/** Read-only order surfaces: the bff-api order services and the SSR order pages. */
export const ALLOWED_PATHS = [
  /^\/bff-api\/order\/[a-z0-9_]+$/,
  /^\/bff-api\/order-api\/order\/(get|query|batch_query|batch_get)_[a-z0-9_]+$/,
  /^\/user\/orders\/[A-Za-z0-9_/]+$/,
  /^\/orders\/track$/,
];

/**
 * Anything that acts on the account. Refused before the allowlist even runs,
 * so a read-looking path with a write verb never gets through.
 */
export const FORBIDDEN_PATH =
  /cancel|submit|modify|update|confirm|delete|remove|apply|urge|verify|edit|save|create|add_|pay|refund_|return_label|revoke|hide/i;

export const MAX_RAW_BYTES = 64 * 1024;

export const rawGet = defineTool({
  name: "raw_get",
  description:
    "Faz um GET autenticado em uma superfície de pedidos da Shein (bff-api/order/*, leituras de " +
    "bff-api/order-api/order/*, páginas SSR /user/orders/* e /orders/track), com o mesmo limite de " +
    "taxa das outras tools. Serve para redescobrir um endpoint quando o site muda; use com parcimônia " +
    "e nunca em rajada. Qualquer path que possa alterar a conta é recusado: este servidor é somente leitura.",
  readOnly: true,
  input: Type.Object({
    path: Type.String({ description: "Path absoluto, ex.: /bff-api/order/list" }),
    query: Type.Optional(
      Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]), {
        description: "Query string extra. `_ver` e `_lang` são preenchidos automaticamente nas chamadas JSON.",
      }),
    ),
    kind: Type.Optional(
      Type.Union([Type.Literal("json"), Type.Literal("html")], {
        description: "json (default) devolve o envelope {code,msg,info}; html devolve a página como texto",
      }),
    ),
    max_bytes: Type.Optional(
      Type.Integer({
        minimum: 1024,
        maximum: MAX_RAW_BYTES,
        description: `Corta a resposta neste tamanho (default ${MAX_RAW_BYTES})`,
      }),
    ),
  }),
  run: async (args, ctx) => {
    const path = args.path.trim();
    if (FORBIDDEN_PATH.test(path)) {
      throw new Error(
        `Path de escrita recusado: "${path}". O shein-mcp é somente leitura e nunca altera a conta.`,
      );
    }
    if (!ALLOWED_PATHS.some((pattern) => pattern.test(path))) {
      throw new Error(
        `Path fora do escopo: "${path}". Só são aceitas as superfícies de pedidos (/bff-api/order/*, ` +
          "leituras de /bff-api/order-api/order/*, /user/orders/* e /orders/track).",
      );
    }

    const kind = args.kind ?? "json";
    const payload = await ctx.http.serial(() => ctx.api.getRaw(path, args.query ?? {}, kind));
    const limit = args.max_bytes ?? MAX_RAW_BYTES;
    const serialized = kind === "json" ? JSON.stringify(payload ?? null) : String(payload);
    const truncated = serialized.length > limit;
    const envelope = kind === "json" ? (payload as { code?: string; msg?: string }) : undefined;
    return {
      path,
      kind,
      code: envelope?.code,
      msg: envelope?.msg,
      truncated,
      bytes: serialized.length,
      data: truncated ? `${serialized.slice(0, limit)}…` : payload,
    };
  },
});
