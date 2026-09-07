# shein-mcp

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-black.svg)](https://bun.sh)
[![TypeScript: strict](https://img.shields.io/badge/typescript-strict-3178c6.svg)](tsconfig.json)
[![CI](https://github.com/maxwellmezadre/shein-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/maxwellmezadre/shein-mcp/actions/workflows/ci.yml)

CLI + servidor MCP para o **histórico de compras da sua conta na Shein**:
pedidos, itens, o breakdown que soma o total (produtos, frete, imposto, taxa de
parcelamento, seguros), rastreio, devoluções e resumos de gastos — com cache
local, para você perguntar quanto gastou sem bater na Shein a cada pergunta.

A Shein não tem API de comprador. O portal de desenvolvedores dela é para
vendedores e **não dá acesso ao histórico da sua própria conta**. Este projeto
fala a mesma API interna que o site usa (`/bff-api/order/*` em `br.shein.com`),
autenticado pelos cookies da sua sessão de navegador. **Somente leitura**:
nenhuma operação de escrita na conta é implementada, e o escape hatch recusa
paths de escrita por construção.

## Sumário

- [Instalação](#instalação)
- [Login](#login)
- [Uso — CLI](#uso--cli)
- [Uso — MCP](#uso--mcp)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Tools](#tools)
- [Como funciona](#como-funciona)
- [Troubleshooting](#troubleshooting)
- [Documentação](#documentação)

## Instalação

Requer [Bun](https://bun.sh) ≥ 1.3 (o cache usa `bun:sqlite`).

### Tudo de uma vez (Claude Code)

```sh
git clone https://github.com/maxwellmezadre/shein-mcp.git
cd shein-mcp
bun install
bun run setup
```

`setup` compila o binário para `~/.local/bin/shein`, registra o servidor MCP
`shein` no seu `~/.claude.json` e instala a skill em `~/.claude/skills/`.

### npm

```sh
npm i -g @maxwellmezadre/shein-mcp   # instala `shein` e `shein-mcp` no PATH
shein --version
```

### Binário único

```sh
bun run build:binary   # gera ./shein, sem precisar de runtime instalado
./shein --version
```

## Login

A senha nunca passa por aqui. Dois caminhos:

```sh
shein login                        # abre o Google Chrome para você entrar
shein login --from-browser chrome  # importa a sessão de um navegador já logado (macOS)
```

O segundo é o mais rápido se você já usa a Shein no Chrome, no Arc, no Brave ou
no Edge: ele lê os cookies pelo Keychain (o macOS pede permissão uma vez) e não
abre janela nenhuma. A sessão é gravada cifrada com AES-256-GCM em
`~/.config/shein-mcp/session.enc` (0600). Detalhes em [`docs/LOGIN.md`](docs/LOGIN.md).

## Uso — CLI

```sh
shein auth --verify                  # a Shein ainda aceita a sessão?
shein sync                           # baixa o histórico para o cache local
shein orders --limit 10              # seus pedidos, do mais novo para o mais antigo
shein order GSH…                     # um pedido inteiro, com o breakdown de preço
shein track GSH…                     # rastreio ao vivo
shein search "conjunto"              # entre os produtos que você já comprou
shein products --limit 20            # agregado por produto
shein product-history "camisola"     # cada compra do produto e a evolução do preço
shein spending --group-by month      # quanto você gastou por mês
shein spending --group-by breakdown  # quanto foi produto, frete, imposto, parcelamento
shein export --format csv            # para planilha
shein doctor                         # qual camada quebrou
```

`--json` funciona em qualquer comando e imprime exatamente o que o cliente MCP
receberia. Referência completa em [`docs/CLI.md`](docs/CLI.md).

## Uso — MCP

O `setup` já registra o servidor. Manualmente, em `~/.claude.json`:

```json
{
  "mcpServers": {
    "shein": { "type": "stdio", "command": "/Users/voce/.local/bin/shein", "args": ["mcp"] }
  }
}
```

Depois é só perguntar: *"quanto gastei na Shein este ano?"*, *"onde está meu
último pedido?"*, *"já comprei essa camisola antes?"*.

## Variáveis de ambiente

Todas opcionais. A tabela completa está em
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

| Variável | Default | Para quê |
| --- | --- | --- |
| `SHEIN_CONFIG_DIR` | `~/.config/shein-mcp` | Onde ficam sessão, chave e cache |
| `SHEIN_BASE_URL` | `https://br.shein.com` | A loja (outro país muda aqui) |
| `SHEIN_TRANSPORT` | `auto` | `auto` \| `fetch` \| `browser` |
| `SHEIN_IMPORT_BROWSER` | — | `arc` \| `chrome` \| `chromium` \| `brave` \| `edge` |
| `SHEIN_READ_ONLY` | `0` | Não registra as tools que escrevem em disco |
| `SHEIN_EXPORT_DIR` | `~/Downloads/shein-export` | O único diretório onde `export` escreve |

## Tools

São 14, iguais no MCP e no CLI. Referência gerada:
[`docs/TOOLS.md`](docs/TOOLS.md).

| Tool | Comando | Rede |
| --- | --- | --- |
| `auth_status` | `shein auth [--verify]` | 0 (1 com `--verify`) |
| `login` | `shein login [--from-browser]` | — |
| `doctor` | `shein doctor` | ≤ 4 |
| `sync` | `shein sync [--full\|--reparse]` | em blocos |
| `list_orders` | `shein orders` | 0 |
| `get_order` | `shein order <billno>` | 0 (1 se não estiver no cache) |
| `track_order` | `shein track <billno>` | 1, sempre ao vivo |
| `search_products` | `shein search <termo>` | 0 |
| `list_products` | `shein products` | 0 |
| `product_history` | `shein product-history <produto>` | 0 |
| `list_returns` | `shein returns` | 0 |
| `spending_summary` | `shein spending` | 0 |
| `export` | `shein export` | 0 |
| `raw_get` | `shein raw <path>` | 1 |

## Como funciona

O site serve o histórico por duas superfícies: páginas SSR que trazem um bloco
`var gbRawData = {…}` e uma API JSON interna (`/bff-api/order/*`) que responde
só com os cookies da sessão. O `sync` percorre a listagem em blocos, guarda o
payload cru de cada pedido e normaliza tudo para um modelo com **dinheiro em
centavos inteiros**; as perguntas depois disso são SQL local.

Duas regras vieram da conta real e são a espinha do projeto:

- **`total` é a soma das linhas de `sorted_price` com `show: "1"`** — verificado
  em 21 de 21 pedidos. Os campos com nome (`subTotalPrice` e afins) são rótulos
  da Shein e **não** formam uma equação.
- O rastreio mora em `packageMap`, não em `trackInfo`: em 8 de 21 páginas o
  segundo simplesmente não existe.

O que a API **não** tem: o número de parcelas (só a taxa). Está documentado em
[`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) para ninguém inventar esse número.

## Troubleshooting

| Sintoma | O que fazer |
| --- | --- |
| `Nenhuma sessão da Shein salva` | `shein login --from-browser chrome` |
| A sessão expirou | Os cookies duram poucos dias: rode o login de novo |
| `A Shein respondeu 00101001` | Pode ser sessão expirada **ou** parâmetro errado: `shein auth --verify` |
| Bloqueio anti-bot | Pare. Abra `br.shein.com` no navegador, resolva a verificação, espere e faça login de novo |
| O cache está vazio | `shein sync` |
| Alguma coisa mudou no site | `shein doctor` diz qual camada quebrou; [`docs/REDISCOVERY.md`](docs/REDISCOVERY.md) diz como remapear |

## Documentação

| Arquivo | Conteúdo |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Camadas, fluxo e as regras que as separam |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | Todas as variáveis e os arquivos em disco |
| [`docs/USAGE.md`](docs/USAGE.md) | Do zero à primeira resposta |
| [`docs/CLI.md`](docs/CLI.md) | Todos os comandos |
| [`docs/TOOLS.md`](docs/TOOLS.md) | Referência das tools (gerada) |
| [`docs/LOGIN.md`](docs/LOGIN.md) | Como o login funciona, o que grava, como revogar |
| [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) | O modelo, as regras de dinheiro e o que não existe |
| [`docs/INTERNAL-API.md`](docs/INTERNAL-API.md) | A API interna: endpoints, envelope, armadilhas |
| [`docs/REDISCOVERY.md`](docs/REDISCOVERY.md) | O que fazer quando a Shein mudar |
| [`docs/adr/`](docs/adr) | As decisões de projeto e por quê |

## Licença

[MIT](LICENSE).
