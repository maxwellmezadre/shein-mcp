#!/usr/bin/env bun
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allTools } from "../src/tools/registry.js";

// The gate: type-check, tests, and the invariants of the real MCP server over
// stdio. If this passes, the PR passes. It never touches the network: there
// is no session in the throwaway config dir, so no request is even attempted.

const ROOT = join(import.meta.dir, "..");
let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.error(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

async function run(name: string, command: string[]): Promise<void> {
  const proc = Bun.spawn(command, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  check(name, (await proc.exited) === 0);
}

type Rpc = { id?: number; result?: Record<string, unknown> };

async function mcp(
  messages: object[],
  env: Record<string, string>,
): Promise<{ replies: Rpc[]; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", "src/bin.ts", "mcp"], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(messages.map((message) => `${JSON.stringify(message)}\n`).join(""));
  await proc.stdin.end();
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  proc.kill();
  const replies = stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Rpc);
  return { replies, stdout, stderr };
}

const handshake = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "0" } },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
];

console.error("Type-check e testes:");
await run("tsc --noEmit", ["bunx", "tsc", "--noEmit"]);
await run("bun test", ["bun", "test"]);

console.error("\nInvariantes das tools:");
const names = allTools.map((tool) => tool.name);
check("nomes únicos e snake_case", new Set(names).size === names.length && names.every((name) => /^[a-z][a-z0-9_]*$/.test(name)));
check(
  "descrições longas o bastante para guiar um modelo",
  allTools.every((tool) => tool.description.length > 40),
  allTools.find((tool) => tool.description.length <= 40)?.name,
);
check(
  "todo input é um objeto JSON Schema",
  allTools.every((tool) => (JSON.parse(JSON.stringify(tool.input)) as { type?: string }).type === "object"),
);

console.error("\nServidor MCP real (stdio, sem rede):");
const home = mkdtempSync(join(tmpdir(), "shein-verify-"));
try {
  const env = { SHEIN_CONFIG_DIR: home, SHEIN_EXPORT_DIR: join(home, "export"), SHEIN_TRANSPORT: "fetch" };
  const { replies, stdout, stderr } = await mcp(
    [
      ...handshake,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "auth_status", arguments: {} } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "raw_get", arguments: { path: "/bff-api/order-api/order/cancel_return_order" } } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "raw_get", arguments: { path: "/bff-api/user-api/common/userinfo_ugid" } } },
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_orders", arguments: { limit: "muitos" } } },
      { jsonrpc: "2.0", id: 8, method: "tools/list" },
    ],
    env,
  );

  check(
    "stdout é 100% JSON-RPC",
    stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .every((line) => (JSON.parse(line) as { jsonrpc?: string }).jsonrpc === "2.0"),
  );
  check("logs saem no stderr", stderr.includes("shein"));
  const list = replies.find((reply) => reply.id === 2)?.result as
    | { tools: Array<{ name: string; description: string; inputSchema: { type?: string } }> }
    | undefined;
  check("tools/list traz o registry inteiro", list?.tools.length === allTools.length);
  check("todo inputSchema anunciado é um objeto", list?.tools.every((tool) => tool.inputSchema.type === "object") === true);
  const status = replies.find((reply) => reply.id === 3)?.result as { isError?: boolean } | undefined;
  check("auth_status responde sem sessão e sem rede", status?.isError === undefined);
  check("auth_status não vaza cookie", !/"cookies"|"value"\s*:/.test(JSON.stringify(status)));
  for (const [id, label] of [
    [4, "tool desconhecida vira isError"],
    [5, "raw_get recusa um path de escrita"],
    [6, "raw_get recusa um path fora do escopo"],
    [7, "argumento inválido vira isError"],
  ] as const) {
    check(label, (replies.find((reply) => reply.id === id)?.result as { isError?: boolean } | undefined)?.isError === true);
  }
  check("o servidor continua respondendo depois de 4 erros", replies.find((reply) => reply.id === 8)?.result !== undefined);

  const readOnly = await mcp([...handshake, { jsonrpc: "2.0", id: 2, method: "tools/list" }], {
    ...env,
    SHEIN_READ_ONLY: "1",
  });
  const readOnlyList = readOnly.replies.find((reply) => reply.id === 2)?.result as
    | { tools: Array<{ name: string }> }
    | undefined;
  check(
    "SHEIN_READ_ONLY registra exatamente o subconjunto somente leitura",
    readOnlyList?.tools.map((tool) => tool.name).join(",") ===
      allTools.filter((tool) => tool.readOnly).map((tool) => tool.name).join(","),
  );
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.error(failures === 0 ? "\nTudo verde." : `\n${failures} verificação(ões) falharam.`);
process.exit(failures === 0 ? 0 : 1);
