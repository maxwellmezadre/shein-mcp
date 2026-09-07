# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/);
versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [Unreleased]

### Changed

- CLI: `shein auth` virou `shein status`, e `shein spending --group-by` virou
  `shein spending --by`, os mesmos nomes dos projetos irmãos. Não há alias
  para os nomes antigos.
- O teste de integração contra a conta real só roda com `SHEIN_LIVE=1` (além
  da sessão salva). Um `bun test` comum não toca mais na rede.
- `scripts/install.ts` aceita `--prefix`, `--skip-build`, `--dry-run` e
  `--import-browser`, e remove entradas por projeto que sombreariam o registro
  de usuário no Claude Code.
- `bun run verify` também confere que os logs saem no stderr, que todo
  `inputSchema` anunciado é um objeto e que `auth_status` não devolve cookie.
- `docs/TOOLS.md` no formato gerado comum aos cinco MCPs (coluna "Escreve",
  tipos com limites).
- Documentação reorganizada no padrão comum: mesmas seções no README, em
  `docs/` e no `SKILL.md`; ADRs no formato `ADR-NNNN: título`; prosa sem
  travessões.
- `playwright-core` ^1.63.

## [0.1.0] - 2026-09-07

Primeira versão.

### Added

- CLI `shein` e servidor MCP `shein-mcp` sobre um núcleo compartilhado, com 14
  tools: `auth_status`, `login`, `doctor`, `sync`, `list_orders`, `get_order`,
  `track_order`, `search_products`, `list_products`, `product_history`,
  `list_returns`, `spending_summary`, `export` e `raw_get`.
- Login por janela do navegador (Playwright) e importação da sessão de um
  navegador já logado no macOS. Sessão cifrada com AES-256-GCM.
- Cliente HTTP serial com ritmo, backoff, breaker anti-bot e cooldown
  persistido; transporte alternativo dentro de um Chrome headless, acionado
  sozinho no primeiro veredito de risco.
- Leitura da API interna `/bff-api/order/*` e dos blocos SSR `gbRawData` e
  `gbOrdersTrackSsrData`.
- Cache SQLite com busca textual sem acento, sync em blocos e retomável, e
  `--reparse`, que reprocessa todo o histórico sem usar a rede.
- Fixtures reais anonimizadas com guarda de vazamento, e um `doctor` que diz
  qual camada quebrou.

### Notas

- O número de parcelas não existe na API da Shein; só a taxa
  (`installmentFee`). Ver [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md).
- `limit` satura em 20. `status_type` é ignorado pelo endpoint JSON, mas
  respeitado pela página SSR: é por lá que `list_returns --verify` confere a
  aba de devoluções.
- A situação do pedido é lida pelos sinais (pago, expiração, pacote assinado),
  não pelo código da Shein: conferido contra as abas do próprio site.
- O total confiável é a soma de `sorted_price` com `show:"1"`; os campos
  nomeados não formam uma equação.
- O endpoint JSON de devoluções continua sem mapear, mas não faz falta: a aba
  "Devolução/Reembolso" do site é `/user/orders/list?status_type=4`, e é o que
  `list_returns --verify` usa.

[Unreleased]: https://github.com/maxwellmezadre/shein-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/maxwellmezadre/shein-mcp/releases/tag/v0.1.0
