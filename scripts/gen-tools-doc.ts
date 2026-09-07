#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { allTools } from "../src/tools/registry.js";

// docs/TOOLS.md is generated from the registry so the reference can never
// drift from the schemas. Run it whenever a tool changes: `bun run docs:tools`.

type Schema = {
  properties?: Record<string, { type?: string; description?: string; anyOf?: unknown[]; enum?: string[] }>;
  required?: string[];
};

const typeOf = (property: { type?: string; anyOf?: unknown[] }): string => {
  if (property.type) return property.type;
  if (Array.isArray(property.anyOf)) {
    const literals = property.anyOf
      .map((entry) => (entry as { const?: string }).const)
      .filter((value): value is string => value !== undefined);
    if (literals.length > 0) return literals.join(" \\| ");
    return "union";
  }
  return "any";
};

const lines: string[] = [
  "# Tools",
  "",
  "> Gerado por `bun run docs:tools` a partir de `src/tools/registry.ts`. Não edite à mão.",
  "",
  `São ${allTools.length} tools. As marcadas como somente leitura continuam disponíveis com`,
  "`SHEIN_READ_ONLY=1`; as outras simplesmente não são registradas nesse modo.",
  "",
  "| Tool | Somente leitura | O que faz |",
  "| --- | --- | --- |",
  ...allTools.map(
    (tool) =>
      `| [\`${tool.name}\`](#${tool.name.replace(/_/g, "")}) | ${tool.readOnly ? "sim" : "não"} | ${tool.description.split(". ")[0]}. |`,
  ),
  "",
];

for (const tool of allTools) {
  const schema = JSON.parse(JSON.stringify(tool.input)) as Schema;
  const properties = Object.entries(schema.properties ?? {});
  lines.push(`## ${tool.name}`, "", tool.description, "");
  if (properties.length === 0) {
    lines.push("Sem parâmetros.", "");
    continue;
  }
  lines.push("| Parâmetro | Tipo | Obrigatório | Descrição |", "| --- | --- | --- | --- |");
  for (const [name, property] of properties) {
    const required = schema.required?.includes(name) ? "sim" : "não";
    lines.push(`| \`${name}\` | ${typeOf(property)} | ${required} | ${property.description ?? ""} |`);
  }
  lines.push("");
}

const path = join(import.meta.dir, "..", "docs", "TOOLS.md");
writeFileSync(path, `${lines.join("\n")}\n`);
console.error(`docs/TOOLS.md: ${allTools.length} tools, ${lines.length} linhas.`);
