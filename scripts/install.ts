#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// One command to make the tool usable: compile the binary, put it on the PATH,
// register the MCP server for Claude Code, and install the skill. Everything is
// idempotent and prints what it did.

const ROOT = join(import.meta.dir, "..");
const HOME = homedir();
const BIN_DIR = join(HOME, ".local", "bin");
const BIN = join(BIN_DIR, "shein");
const CLAUDE_JSON = join(HOME, ".claude.json");
const SKILL_DIR = join(HOME, ".claude", "skills", "shein-mcp");

const dry = process.argv.includes("--dry-run");
const say = (message: string) => console.error(message);

async function build(): Promise<void> {
  say("Compilando o binário…");
  if (dry) return;
  const proc = Bun.spawn(["bun", "build", "--compile", "src/bin.ts", "--outfile", BIN], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await proc.exited) !== 0) throw new Error("bun build --compile falhou");
  chmodSync(BIN, 0o755);
}

function registerMcp(): void {
  say(`Registrando o servidor MCP em ${CLAUDE_JSON}…`);
  if (dry) return;
  const config = existsSync(CLAUDE_JSON)
    ? (JSON.parse(readFileSync(CLAUDE_JSON, "utf8")) as Record<string, unknown>)
    : {};
  const servers = (config.mcpServers as Record<string, unknown>) ?? {};
  // An absolute path: Claude Code does not inherit the shell's PATH.
  servers.shein = { type: "stdio", command: BIN, args: ["mcp"], env: {} };
  config.mcpServers = servers;
  writeFileSync(CLAUDE_JSON, `${JSON.stringify(config, null, 2)}\n`);
}

function installSkill(): void {
  say(`Instalando a skill em ${SKILL_DIR}…`);
  if (dry) return;
  mkdirSync(SKILL_DIR, { recursive: true });
  for (const file of ["SKILL.md", join("docs", "TOOLS.md")]) {
    const source = join(ROOT, file);
    if (existsSync(source)) writeFileSync(join(SKILL_DIR, file.split("/").pop() as string), readFileSync(source));
  }
}

mkdirSync(BIN_DIR, { recursive: true });
await build();
registerMcp();
installSkill();

say("");
say(`Binário:  ${BIN}`);
say(`MCP:      shein (reinicie o Claude Code para ele aparecer)`);
say(`Skill:    ${SKILL_DIR}`);
say("");
say("Próximo passo: `shein login --from-browser chrome` e depois `shein sync`.");
if (!process.env.PATH?.includes(BIN_DIR)) {
  say(`\nAtenção: ${BIN_DIR} não está no seu PATH.`);
}
