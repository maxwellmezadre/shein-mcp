# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/);
versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [Unreleased]

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

- O **número de parcelas não existe** na API da Shein; só a taxa
  (`installmentFee`). Ver [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md).
- `limit` satura em 20 e `status_type` é ignorado pelo servidor: filtrar por
  situação é trabalho do cache.
- O total confiável é a soma de `sorted_price` com `show:"1"` — os campos
  nomeados não formam uma equação.
- O histórico de devoluções continua sem mapear; `list_returns` responde pelo
  que o detalhe do pedido carrega e diz isso na resposta.

[Unreleased]: https://github.com/maxwellmezadre/shein-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/maxwellmezadre/shein-mcp/releases/tag/v0.1.0
