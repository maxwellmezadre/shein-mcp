import { Type } from "@sinclair/typebox";
import { IMPORT_BROWSERS } from "../config.js";
import { importFromBrowser } from "../session/browser-import.js";
import { DEFAULT_LOGIN_TIMEOUT_MS, runLogin } from "../session/login.js";
import { authStatus } from "./auth.js";
import { defineTool, runTool } from "./define.js";

// Login as an MCP tool as well as a CLI command: the browser window opens on
// the machine running the server and the call blocks until the user is done.
// The CLI is still the primary path — some MCP clients time out first.

export const login = defineTool({
  name: "login",
  description:
    "Abre uma janela do Google Chrome para o usuário entrar na conta da Shein e guarda a sessão " +
    "cifrada (a senha nunca passa por aqui). Bloqueia até o login terminar — até 15 minutos. " +
    "Com from_browser (ou SHEIN_IMPORT_BROWSER), importa a sessão de um navegador já logado (Arc, Chrome… só macOS) " +
    "em vez de abrir a janela. Prefira o comando de terminal `shein login` quando o cliente MCP tiver timeout curto.",
  readOnly: false,
  input: Type.Object({
    timeout_seconds: Type.Optional(
      Type.Integer({
        minimum: 60,
        maximum: 900,
        description: `Tempo máximo esperando o login (default ${DEFAULT_LOGIN_TIMEOUT_MS / 1000})`,
      }),
    ),
    fresh: Type.Optional(
      Type.Boolean({
        description:
          "Apaga o perfil do navegador de automação antes (login do zero; no import, a Shein passa a ver um dispositivo novo)",
      }),
    ),
    from_browser: Type.Optional(
      Type.Union(
        IMPORT_BROWSERS.map((browser) => Type.Literal(browser)),
        { description: "Importa os cookies de um navegador já logado (só macOS) em vez de abrir uma janela" },
      ),
    ),
  }),
  run: async (args, ctx) => {
    const browser = args.from_browser ?? ctx.config.importBrowser;
    const result = browser
      ? await importFromBrowser(ctx, { browser, ...(args.fresh ? { fresh: true } : {}) })
      : await runLogin(ctx, {
          ...(args.timeout_seconds ? { timeoutMs: args.timeout_seconds * 1000 } : {}),
          ...(args.fresh ? { fresh: true } : {}),
        });
    // Prove the session works before telling anyone it is ready (1 request).
    const status = await runTool(authStatus, { verify: true }, ctx);
    return { ...result, source: browser ?? "browser-window", status };
  },
});
