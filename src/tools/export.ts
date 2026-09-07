import { Type } from "@sinclair/typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { toDecimal } from "../domain/money.js";
import { defineTool } from "./define.js";

// Writes the cache to a file the user can open. The only directory it may
// write to is SHEIN_EXPORT_DIR, and the filename is reduced to its basename:
// a path a model composed must never reach outside it.

const CENTS_SUFFIX = /_cents$/;

/** Cents columns become decimal columns, so a spreadsheet reads them as money. */
function toRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) =>
        CENTS_SUFFIX.test(key) && typeof value === "number"
          ? [key.replace(CENTS_SUFFIX, ""), toDecimal(value)]
          : [key, value],
      ),
    ),
  );
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0] as Record<string, unknown>);
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = rows.map((row) => headers.map((header) => cell(row[header])).join(","));
  return [headers.join(","), ...lines].join("\n");
}

/**
 * A filename, reduced to something that cannot mean anything but a file in the
 * export directory: percent-escapes are decoded first (so `..%2Fx` cannot slip
 * a separator past `basename`), then the directory parts and every remaining
 * `..` are removed. Returns null when nothing usable is left.
 */
export function safeFilename(requested: string | undefined): string | null {
  if (!requested) return null;
  let decoded = requested;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    // A malformed escape stays as it is; the cleanup below still applies.
  }
  const cleaned = basename(decoded)
    .replace(/[/\\]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^[.\s]+/, "")
    .trim();
  return cleaned === "" ? null : cleaned;
}

export const exportData = defineTool({
  name: "export",
  description:
    "Exporta o cache para um arquivo CSV ou JSON, com os pedidos ou os itens. Grava sempre dentro de " +
    "SHEIN_EXPORT_DIR (default ~/Downloads/shein-export) e devolve o caminho. Valores saem em reais " +
    "decimais, prontos para planilha.",
  readOnly: false,
  input: Type.Object({
    format: Type.Optional(
      Type.Union([Type.Literal("csv"), Type.Literal("json")], { description: "csv (default) | json" }),
    ),
    scope: Type.Optional(
      Type.Union([Type.Literal("orders"), Type.Literal("items")], { description: "orders (default) | items" }),
    ),
    filename: Type.Optional(
      Type.String({ description: "Nome do arquivo (só o nome: o diretório é sempre o de exportação)" }),
    ),
  }),
  run: (args, ctx) => {
    const format = args.format ?? "csv";
    const scope = args.scope ?? "orders";
    const cache = ctx.cache();
    const rows = toRows(scope === "orders" ? cache.exportOrders() : cache.exportItems());

    const stamp = new Date(ctx.now()).toISOString().slice(0, 10);
    const name = safeFilename(args.filename) ?? `shein-${scope}-${stamp}.${format}`;
    mkdirSync(ctx.config.exportDir, { recursive: true, mode: 0o700 });
    const path = join(ctx.config.exportDir, name);
    const body = format === "json" ? `${JSON.stringify(rows, null, 2)}\n` : `${toCsv(rows)}\n`;
    writeFileSync(path, body, { mode: 0o600 });
    return { path, format, scope, rows: rows.length, bytes: body.length };
  },
});
