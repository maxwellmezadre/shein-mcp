# ADR-0003 — TypeBox como fonte única do schema

- **Status:** Aceito
- **Contexto:** cada tool precisa de três coisas que costumam divergir: o tipo
  estático dos argumentos, a validação em runtime e o JSON Schema anunciado ao
  cliente MCP.

## Decisão

Um `Type.Object` por tool é as três. `defineTool` guarda o schema, `runTool`
valida com `Value.Check` e o servidor MCP publica o mesmo objeto como
`inputSchema` — ele já é JSON Schema válido.

## Consequências

Zod não entra (precisaria de uma ponte para JSON Schema). A documentação das
tools é gerada do registry (`bun run docs:tools`), então também não diverge.
