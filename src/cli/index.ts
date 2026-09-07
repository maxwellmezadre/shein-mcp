import { Command } from "commander";
import { loadConfig } from "../config.js";
import { type Ctx, createContext } from "../context.js";
import { runTool } from "../tools/define.js";
import { toolByName } from "../tools/registry.js";
import { render } from "./render.js";

// The CLI is a thin shell over the SAME registry the MCP server uses: every
// command is one `runTool` call, so the two surfaces cannot drift. `--json` on
// any command prints exactly what the MCP client would receive.

type Options = Record<string, unknown>;

/**
 * stdout is a pipe when the output is redirected, and a large write can be cut
 * short if the process exits before it drains. Waiting for the flush is what
 * makes `shein orders --json > file` complete.
 */
async function write(text: string): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.write(`${text}\n`, () => resolve());
  });
}

export async function runCli(argv: string[], version: string): Promise<void> {
  const program = new Command();
  program
    .name("shein")
    .description("Histórico de compras da Shein: pedidos, produtos, rastreio e gastos")
    .version(version)
    .option("--json", "Imprime o resultado como JSON")
    .enablePositionalOptions();

  let ctx: Ctx | undefined;
  const context = (): Ctx => {
    ctx ??= createContext(loadConfig());
    return ctx;
  };

  /** Declares a command that simply runs a tool with the arguments it built. */
  const command = (
    signature: string,
    description: string,
    toolName: string,
    build: (options: Options, ...args: string[]) => Record<string, unknown> = () => ({}),
    configure: (cmd: Command) => Command = (cmd) => cmd,
  ): void => {
    // `--json` is accepted on every command as well as before it: a user who
    // types `shein orders --json` should not have to learn where it goes.
    const cmd = program.command(signature).description(description).option("--json", "Imprime o resultado como JSON");
    configure(cmd).action(async (...actionArgs: unknown[]) => {
      // commander hands the positionals first, then the options, then itself.
      const positionals = actionArgs.slice(0, -2) as string[];
      const options = actionArgs[actionArgs.length - 2] as Options;
      const tool = toolByName(toolName);
      if (!tool) throw new Error(`Tool desconhecida: ${toolName}`);
      const result = await runTool(tool, build(options, ...positionals), context());
      const json = Boolean(program.opts().json ?? options.json);
      await write(json ? JSON.stringify(result, null, 2) : render(result));
    });
  };

  const day = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  const num = (value: unknown): number | undefined => (value === undefined ? undefined : Number(value));
  const drop = (record: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

  command(
    "auth",
    "Mostra o estado da sessão salva",
    "auth_status",
    (options) => drop({ verify: options.verify }),
    (cmd) => cmd.option("--verify", "Gasta 1 requisição para confirmar que a Shein aceita a sessão"),
  );

  command(
    "login",
    "Abre o navegador para entrar na conta, ou importa a sessão de um navegador já logado",
    "login",
    (options) =>
      drop({
        from_browser: options.fromBrowser,
        fresh: options.fresh,
        timeout_seconds: num(options.timeout),
      }),
    (cmd) =>
      cmd
        .option("--from-browser <navegador>", "arc | chrome | chromium | brave | edge")
        .option("--fresh", "Apaga o perfil do navegador de automação antes")
        .option("--timeout <segundos>", "Tempo máximo esperando o login"),
  );

  command("doctor", "Diagnostica sessão, endpoints e cache", "doctor");

  command(
    "sync",
    "Baixa o histórico para o cache local, em blocos",
    "sync",
    (options) =>
      drop({
        mode: options.full ? "full" : options.reparse ? "reparse" : undefined,
        max_requests: num(options.maxRequests),
        with_tracking: options.withTracking,
      }),
    (cmd) =>
      cmd
        .option("--full", "Varre todo o histórico de novo")
        .option("--reparse", "Reprocessa o que já está salvo, sem rede")
        .option("--max-requests <n>", "Teto de requisições nesta chamada")
        .option("--with-tracking", "Também busca o rastreio dos pedidos enviados"),
  );

  command(
    "orders",
    "Lista os pedidos do cache",
    "list_orders",
    (options) =>
      drop({
        status: options.status,
        from: day(options.from),
        to: day(options.to),
        store: options.store,
        checkout_id: options.checkout,
        archived: options.archived,
        limit: num(options.limit),
        offset: num(options.offset),
        compact: options.compact,
      }),
    (cmd) =>
      cmd
        .option("--status <situação>", "unpaid | processing | shipped | delivered | returned | cancelled")
        .option("--from <YYYY-MM-DD>", "Início do período")
        .option("--to <YYYY-MM-DD>", "Fim do período")
        .option("--store <nome>", "Nome exato da loja")
        .option("--checkout <id>", "Pedidos de uma mesma compra")
        .option("--archived", "Só pedidos arquivados")
        .option("--limit <n>", "Máximo de pedidos")
        .option("--offset <n>", "Pedidos a pular")
        .option("--compact", "Só os campos essenciais"),
  );

  command(
    "order <billno>",
    "Detalhe completo de um pedido",
    "get_order",
    (options, billno) => drop({ billno, include_address: options.includeAddress, compact: options.compact }),
    (cmd) =>
      cmd
        .option("--include-address", "Inclui o endereço de entrega (dado pessoal)")
        .option("--compact", "Só os campos essenciais"),
  );

  command(
    "track <billno>",
    "Rastreio ao vivo de um pedido",
    "track_order",
    (options, billno) => drop({ billno, limit_events: num(options.limitEvents) }),
    (cmd) => cmd.option("--limit-events <n>", "Máximo de eventos por pacote"),
  );

  command(
    "search <consulta>",
    "Busca entre os produtos já comprados",
    "search_products",
    (options, query) => drop({ query, limit: num(options.limit) }),
    (cmd) => cmd.option("--limit <n>", "Máximo de itens"),
  );

  command(
    "products",
    "Produtos comprados, agregados por produto",
    "list_products",
    (options) =>
      drop({
        store: options.store,
        category: options.category,
        from: day(options.from),
        to: day(options.to),
        limit: num(options.limit),
      }),
    (cmd) =>
      cmd
        .option("--store <nome>", "Nome exato da loja")
        .option("--category <cat_id>", "Categoria da Shein")
        .option("--from <YYYY-MM-DD>", "Início do período")
        .option("--to <YYYY-MM-DD>", "Fim do período")
        .option("--limit <n>", "Máximo de produtos"),
  );

  command(
    "product-history <produto>",
    "Todas as compras de um produto, com a evolução do preço",
    "product_history",
    (_options, product) => ({ product }),
  );

  command(
    "returns",
    "Itens com devolução ou reembolso registrados",
    "list_returns",
    (options) =>
      drop({ verify: options.verify, from: day(options.from), to: day(options.to), limit: num(options.limit) }),
    (cmd) =>
      cmd
        .option("--verify", "Confere na aba de devoluções do site (1 requisição)")
        .option("--from <YYYY-MM-DD>", "Início do período")
        .option("--to <YYYY-MM-DD>", "Fim do período")
        .option("--limit <n>", "Máximo de itens"),
  );

  command(
    "spending",
    "Quanto foi gasto, agrupado",
    "spending_summary",
    (options) => drop({ group_by: options.groupBy, from: day(options.from), to: day(options.to) }),
    (cmd) =>
      cmd
        .option("--group-by <grupo>", "month | year | store | payment | breakdown")
        .option("--from <YYYY-MM-DD>", "Início do período")
        .option("--to <YYYY-MM-DD>", "Fim do período"),
  );

  command(
    "export",
    "Exporta o cache para CSV ou JSON",
    "export",
    (options) => drop({ format: options.format, scope: options.scope, filename: options.out }),
    (cmd) =>
      cmd
        .option("--format <formato>", "csv | json")
        .option("--scope <escopo>", "orders | items")
        .option("--out <arquivo>", "Nome do arquivo dentro do diretório de exportação"),
  );

  command(
    "raw <path>",
    "GET autenticado em uma superfície de pedidos (redescoberta)",
    "raw_get",
    (options, path) =>
      drop({
        path,
        kind: options.kind,
        max_bytes: num(options.maxBytes),
        query: parseQuery(options.query as string[] | undefined),
      }),
    (cmd) =>
      cmd
        .option("--query <k=v...>", "Parâmetros extras", collect, [] as string[])
        .option("--kind <tipo>", "json | html")
        .option("--max-bytes <n>", "Corta a resposta neste tamanho"),
  );

  program.command("mcp").description("Inicia o servidor MCP (stdio)").action(() => {
    // bin.ts handles this before commander is loaded; here only for `--help`.
    throw new Error("Use `shein mcp` diretamente.");
  });

  try {
    await program.parseAsync(argv);
  } finally {
    await ctx?.dispose();
  }
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

function parseQuery(pairs: string[] | undefined): Record<string, string> | undefined {
  if (!pairs || pairs.length === 0) return undefined;
  const query: Record<string, string> = {};
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index > 0) query[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return Object.keys(query).length > 0 ? query : undefined;
}
