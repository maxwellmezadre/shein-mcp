# ADR-0004: `Server` de baixo nível do SDK do MCP

## Contexto

Status: aceito.

O SDK oferece `McpServer.registerTool`, que quer schemas no
padrão Standard Schema (Zod e afins). Os nossos já são JSON Schema.

## Decisão

Usar o `Server` de baixo nível e responder `ListTools`/`CallTool` à mão. Todo
uso do SDK fica confinado em `src/mcp/server.ts`.

## Consequências

Umas 20 linhas a mais, e nenhuma conversão de schema. Trocar de SDK, se um dia
precisar, mexe em um arquivo só.
