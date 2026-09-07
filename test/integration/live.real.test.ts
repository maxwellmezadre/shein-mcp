import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { runTool } from "../../src/tools/define.js";
import { toolByName } from "../../src/tools/registry.js";
import type { AuthStatus } from "../../src/tools/auth.js";

// Real requests to Shein, against the session on THIS machine. Opt-in and
// self-skipping: CI has no session, so it never runs there. It spends about
// four requests, paced by the normal client.
//
//   bun test test/integration
//
// Nothing here asserts on account data (amounts, ids, names): it checks that
// the layers still answer the shape the parsers expect.

const config = (() => {
  try {
    return loadConfig();
  } catch {
    return null;
  }
})();
const available = config !== null && existsSync(config.sessionPath);
const gated = available ? describe : describe.skip;

gated("live shein", () => {
  const context = () => createContext(loadConfig());

  test(
    "the session is still accepted and the list answers the expected envelope",
    async () => {
      const ctx = context();
      try {
        const status = (await runTool(toolByName("auth_status") as never, { verify: true }, ctx)) as AuthStatus;
        expect(status.loggedIn).toBe(true);
        expect(status.verified).toBe(true);
        expect(status.memberId).toBeTruthy();
        expect(typeof status.totalOrders).toBe("number");
      } finally {
        await ctx.dispose();
      }
    },
    60_000,
  );

  test(
    "doctor reaches every layer, and the price rows still add up to the total",
    async () => {
      const ctx = context();
      try {
        const report = (await runTool(toolByName("doctor") as never, {}, ctx)) as {
          ok: boolean;
          checks: Array<{ name: string; ok: boolean; detail: string }>;
        };
        for (const check of report.checks) {
          expect(`${check.name}: ${check.ok ? "ok" : check.detail}`).toContain("ok");
        }

        // The identity the whole money model rests on, checked live.
        const page = await ctx.http.serial(() => ctx.api.listOrders({ page: 1, limit: 1, statusType: 0 }));
        const billno = page.order_list?.[0]?.billno;
        expect(billno).toBeTruthy();
        const detail = await ctx.http.serial(() => ctx.api.getOrderDetail(billno as string));
        const shown = (detail.sorted_price ?? []).filter((row) => String(row.show) === "1");
        const cents = (value: string | undefined) => Math.round(Number(value ?? 0) * 100);
        expect(shown.reduce((sum, row) => sum + cents(row.amount), 0)).toBe(cents(detail.totalPrice?.amount));
      } finally {
        await ctx.dispose();
      }
    },
    120_000,
  );
});
