# ADR-0001: Arquitetura em camadas, pragmática

## Contexto

Status: aceito.

O projeto tem duas entradas (CLI e MCP), uma API instável de
terceiro e um cache. Sem uma separação clara, a mudança de um nome de campo
no site vira uma caçada por todo o repositório.

## Decisão

Camadas com uma dependência só, de cima para baixo: transporte (bin/cli/mcp) →
aplicação (tools/context) → domínio (domain/cache) → Shein (shein) → infra
(core/session). Sem container de injeção: `createContext(loadConfig())` monta
tudo, e o que depende de tempo, rede ou disco é passado como parâmetro.

## Consequências

Testar não exige mock global: os testes injetam um `fetch` roteirizado, um
relógio falso e um SQLite em memória. Em troca, `context.ts` é um pouco
verboso: é o preço de não ter mágica.
