# Arquitetura

```
        ┌──────────────────────────────────────────────┐
        │  Transporte / entradas                       │
        │  src/bin.ts · src/cli/ · src/mcp/            │
        └───────────────┬──────────────────────────────┘
                        │ usa
        ┌───────────────▼──────────────────────────────┐
        │  Aplicação: src/tools/ · src/context.ts      │
        └───────────────┬──────────────────────────────┘
                        │
        ┌───────────────▼──────────────────────────────┐
        │  Domínio: src/domain/ · src/cache/           │
        │  (não conhece MCP, CLI nem HTTP)             │
        └───────────────┬──────────────────────────────┘
                        │
        ┌───────────────▼──────────────────────────────┐
        │  Shein: src/shein/                           │
        └───────────────┬──────────────────────────────┘
                        │
        ┌───────────────▼──────────────────────────────┐
        │  Infra: src/core/ · src/session/ · config    │
        └──────────────────────────────────────────────┘
```

## Fluxo de uma pergunta

1. `bin.ts` decide entre servidor MCP e CLI (import preguiçoso por modo: o
   caminho MCP nunca carrega o commander).
2. `context.ts` monta tudo: config, logger, sessão, cliente HTTP, API, cache.
   Nada é global; tudo o que depende de tempo, rede ou disco é injetável.
3. A tool valida os argumentos contra o schema TypeBox e roda.
4. Se precisar da rede, passa por `core/http.ts` (fila serial, ritmo, backoff,
   breaker). Se precisar de dado, passa por `cache/repo.ts` (SQL
   parametrizado).
5. `domain/normalize.ts` traduz o payload cru para o modelo. É o único arquivo
   que conhece nomes de campo da Shein.

## Regras

Não são estilo; são o que mantém o projeto consertável quando a Shein mudar.

1. Nenhuma rede fora de `src/core/http.ts`.
2. Só `src/domain/normalize.ts` conhece nomes de campo da Shein. Uma
   renomeação no site é uma mudança ali e em lugar nenhum mais.
3. SDK do MCP só em `src/mcp/`; commander só em `src/cli/`. `playwright-core`
   só por import dinâmico, em `src/session/login.ts` e
   `src/core/browser-transport.ts`.
4. Dinheiro em centavo inteiro para dentro; decimal só na borda da tool
   (`src/tools/present.ts`).
5. stdout é do JSON-RPC. Todo log vai para stderr.
6. Falha de tool vira `isError`, nunca derruba o servidor.
7. Nada de escrita na conta. Nem uma tool, nem um path no `raw_get`.

## O que cada diretório faz

| Diretório | Papel |
| --- | --- |
| `src/bin.ts`, `src/mcp-bin.ts` | Entradas: decidem entre CLI e servidor MCP |
| `src/cli/` | commander, um comando por tool, e o `render.ts` da saída legível |
| `src/mcp/` | O `Server` de baixo nível do SDK: `tools/list` e `tools/call` |
| `src/tools/` | As 14 tools (`define.ts`, `registry.ts`) e a apresentação (`present.ts`, `fields.ts`) |
| `src/context.ts`, `src/config.ts` | Montagem dos colaboradores e a configuração validada por TypeBox |
| `src/domain/` | O modelo, dinheiro em centavos, datas, situação e o `normalize.ts` |
| `src/cache/` | SQLite: schema, repositório, linhas, `sync` em blocos e as consultas analíticas |
| `src/shein/` | Os endpoints, os tipos crus e o parser dos blocos SSR (`gbdata.ts`) |
| `src/core/` | HTTP serial com breaker, transporte por navegador, erros, logger, SQLite |
| `src/session/` | Jar cifrado, login por janela e importação de cookies do navegador |
| `scripts/` | `verify`, `install`, `gen-tools-doc`, `capture-fixtures`, `anonymize-fixture` |
| `test/` | Testes com colaboradores injetados; fixtures anonimizadas em `test/fixtures/` |

## Por que cache

O histórico de um pedido finalizado é imutável, a Shein limita o ritmo, e
qualquer pergunta analítica ("quanto gastei em lingerie") custaria uma varredura
inteira. O cache guarda também o payload cru de cada pedido, então um parser
melhor pode ser reaplicado sobre todo o histórico sem uma única requisição
(`sync --reparse`).

## Por que dois transportes

`SHEIN_TRANSPORT=auto` começa em HTTP puro, que é o que funciona hoje. Se a
Shein aplicar um veredito anti-bot, o cliente troca uma vez para um Chrome
headless que abre a própria página de pedidos e executa os mesmos `fetch` de
dentro dela: a assinatura de dispositivo do site é a que vale, e nada é
imitado. Um segundo veredito arma o breaker e grava um cooldown que sobrevive
ao processo. Detalhes na [ADR-0009](adr/0009-transport-and-anti-bot.md).

## Testes

`bun test`, sem framework de mock: `test/helpers.ts` monta um contexto com
`fetch` roteirizado, relógio falso e SQLite em memória. Os fixtures são
capturas reais anonimizadas, e `test/fixtures.test.ts` falha se um dado
pessoal aparecer nelas. Duas suítes se ignoram sozinhas: `test/local/` precisa
do corpus cru em `task/captures/`, e `test/integration/` só roda com
`SHEIN_LIVE=1` e uma sessão salva. `bun run verify` é o portão: type-check,
testes e as invariantes do servidor MCP real sobre stdio, sem rede.
