// One renderer for every command: the tools already answer with flat objects
// and arrays of flat objects, so a table plus key/value lines covers all of
// them. `--json` is there for anything a script wants to parse.

const isPlain = (value: unknown): boolean =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

const cell = (value: unknown): string => {
  if (value === null || value === undefined) return "-";
  if (Array.isArray(value)) return value.map(cell).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

/** An array of objects becomes a column-aligned table. */
function table(rows: Array<Record<string, unknown>>): string {
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((header) =>
    rows.some((row) => isPlain(row[header]) || Array.isArray(row[header])),
  );
  const widths = headers.map((header) =>
    Math.max(header.length, ...rows.map((row) => cell(row[header]).length)),
  );
  const line = (cells: string[]) =>
    cells.map((text, index) => text.padEnd(widths[index] as number)).join("  ").trimEnd();
  return [
    line(headers),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map((row) => line(headers.map((header) => cell(row[header])))),
  ].join("\n");
}

export function render(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (Array.isArray(result)) {
    return result.every((item) => item && typeof item === "object")
      ? table(result as Array<Record<string, unknown>>)
      : result.map(cell).join("\n");
  }
  if (typeof result !== "object") return String(result);

  const entries = Object.entries(result as Record<string, unknown>);
  const scalars = entries.filter(([, value]) => isPlain(value));
  const lists = entries.filter(
    ([, value]) => Array.isArray(value) && value.length > 0 && typeof value[0] === "object",
  );
  const objects = entries.filter(
    ([, value]) => value !== null && typeof value === "object" && !Array.isArray(value),
  );

  const parts: string[] = [];
  if (scalars.length > 0) {
    const width = Math.max(...scalars.map(([key]) => key.length));
    parts.push(scalars.map(([key, value]) => `${key.padEnd(width)}  ${cell(value)}`).join("\n"));
  }
  for (const [key, value] of objects) {
    parts.push(`\n[${key}]\n${render(value)}`);
  }
  for (const [key, value] of lists) {
    parts.push(`\n[${key}] (${(value as unknown[]).length})\n${table(value as Array<Record<string, unknown>>)}`);
  }
  return parts.join("\n");
}
