import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config.js";

// loadConfig takes `env` as a parameter so tests never touch process.env.
const base = { SHEIN_CONFIG_DIR: "/tmp/shein-test" };

describe("loadConfig defaults", () => {
  test("derives every path from the config dir", () => {
    const config = loadConfig(base);
    expect(config.configDir).toBe("/tmp/shein-test");
    expect(config.sessionPath).toBe("/tmp/shein-test/session.enc");
    expect(config.keyPath).toBe("/tmp/shein-test/session.key");
    expect(config.dbPath).toBe("/tmp/shein-test/cache.db");
    expect(config.browserProfileDir).toBe("/tmp/shein-test/browser-profile");
  });

  test("falls back to ~/.config/shein-mcp", () => {
    const config = loadConfig({});
    expect(config.configDir).toBe(join(homedir(), ".config", "shein-mcp"));
    expect(config.exportDir).toBe(join(homedir(), "Downloads", "shein-export"));
  });

  test("expands a leading ~/ (MCP configs are JSON, not shell)", () => {
    const config = loadConfig({ SHEIN_CONFIG_DIR: "~/sh", SHEIN_EXPORT_DIR: "~/out" });
    expect(config.configDir).toBe(join(homedir(), "sh"));
    expect(config.exportDir).toBe(join(homedir(), "out"));
  });

  test("keeps the conservative pacing defaults and the Brazilian site", () => {
    const config = loadConfig(base);
    expect(config.minIntervalMs).toBe(1000);
    expect(config.jitterMs).toBe(500);
    expect(config.httpTimeoutMs).toBe(30_000);
    expect(config.baseUrl).toBe("https://br.shein.com");
    expect(config.lang).toBe("pt-br");
    expect(config.transport).toBe("auto");
    expect(config.browserChannel).toBe("chrome");
    expect(config.readOnly).toBe(false);
    expect(config.compact).toBe(false);
    expect(config.importBrowser).toBeUndefined();
  });
});

describe("loadConfig validation", () => {
  test("accepts every documented boolean spelling", () => {
    for (const value of ["1", "true", "yes", "on"]) {
      expect(loadConfig({ ...base, SHEIN_READ_ONLY: value }).readOnly).toBe(true);
    }
    for (const value of ["0", "false", "no", "off"]) {
      expect(loadConfig({ ...base, SHEIN_READ_ONLY: value }).readOnly).toBe(false);
    }
  });

  test("rejects a non-boolean instead of defaulting silently", () => {
    expect(() => loadConfig({ ...base, SHEIN_COMPACT: "maybe" })).toThrow(ConfigError);
  });

  test("rejects a session key that is not 32 bytes of base64", () => {
    expect(() => loadConfig({ ...base, SHEIN_SESSION_KEY: "dG9vIHNob3J0" })).toThrow(/32 bytes/);
    const key = Buffer.alloc(32, 7).toString("base64");
    expect(loadConfig({ ...base, SHEIN_SESSION_KEY: key }).sessionKey).toBe(key);
  });

  test("rejects an unknown transport, browser channel or import browser", () => {
    expect(() => loadConfig({ ...base, SHEIN_TRANSPORT: "curl" })).toThrow(/auto\|fetch\|browser/);
    expect(() => loadConfig({ ...base, SHEIN_BROWSER_CHANNEL: "safari" })).toThrow(
      /chrome\|chromium\|msedge/,
    );
    expect(() => loadConfig({ ...base, SHEIN_IMPORT_BROWSER: "safari" })).toThrow(/arc\|chrome/);
    expect(loadConfig({ ...base, SHEIN_TRANSPORT: "Browser" }).transport).toBe("browser");
    expect(loadConfig({ ...base, SHEIN_IMPORT_BROWSER: "arc" }).importBrowser).toBe("arc");
  });

  test("rejects a non-http base url and strips trailing slashes", () => {
    expect(() => loadConfig({ ...base, SHEIN_BASE_URL: "ftp://x" })).toThrow(/http\(s\)/);
    expect(loadConfig({ ...base, SHEIN_BASE_URL: "https://acme.test/" }).baseUrl).toBe(
      "https://acme.test",
    );
  });

  test("reports every problem at once so the user fixes them in one go", () => {
    try {
      loadConfig({
        ...base,
        SHEIN_READ_ONLY: "maybe",
        SHEIN_MIN_INTERVAL_MS: "-5",
        SHEIN_IMPORT_BROWSER: "safari",
      });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toHaveLength(3);
      expect((error as ConfigError).message).toContain("shein-mcp");
    }
  });
});
