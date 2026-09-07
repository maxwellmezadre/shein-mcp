#!/usr/bin/env bun
// Static JSON import: the bundler embeds the version, so it also works in the
// compiled binary (`bun build --compile`), where there is no package.json next
// to the executable.
import pkg from "../package.json" with { type: "json" };

// Lazy import per mode keeps the cold start low: the MCP server never loads the
// CLI (commander) and vice versa. `mcp` is the fast path; everything else goes
// to the CLI.
const arg = process.argv[2];

if (arg === "mcp") {
  const [{ loadConfig }, { createContext }, { startMcpServer }] = await Promise.all([
    import("./config.js"),
    import("./context.js"),
    import("./mcp/server.js"),
  ]);
  await startMcpServer(createContext(loadConfig()), pkg.version);
} else if (arg === "--version" || arg === "-V") {
  console.log(pkg.version);
} else {
  // ponytail: the commander CLI lands in a later step; until then only `mcp` runs.
  console.error("shein: o CLI ainda está em construção — use `shein mcp` ou `shein --version`.");
  process.exit(1);
}
