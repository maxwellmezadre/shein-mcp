---
name: shein-mcp
description: >-
  Histórico de compras da Shein da conta do usuário via MCP `shein`: pedidos,
  itens, preço pago, frete, imposto, taxa de parcelamento, rastreio ao vivo,
  produtos recomprados e resumos de gastos, com cache local. Use para perguntas
  como "quanto gastei na Shein", "quando comprei aquele conjunto", "onde está
  meu pedido", "quanto foi de frete". Triggers: shein, pedido, compra, comprei,
  rastreio, entrega, encomenda, quanto gastei, frete, imposto, parcelamento,
  devolução, reembolso, loja, billno, lingerie, roupa.
---

# Shein — histórico de compras

MCP `shein` (`mcp__shein__*`), 14 tools. Referência completa de parâmetros em
`TOOLS.md`, ao lado deste arquivo.

## Leia antes de responder

1. **Comece por `auth_status`** quando qualquer coisa falhar. Sem sessão, nada
   funciona, e a correção é o usuário rodar `shein login --from-browser chrome`
   no terminal — você não consegue fazer o login por ele.
2. **O cache responde quase tudo.** `list_orders`, `get_order`,
   `search_products`, `list_products`, `product_history`, `spending_summary`,
   `list_returns` e `export` não usam a rede. Se vierem vazios, rode `sync`.
3. **`sync` trabalha em blocos.** Se devolver `done: false`, chame de novo com
   os mesmos parâmetros até `done: true`. Não aumente `max_requests` para
   "acelerar": o ritmo existe para não levar bloqueio.
4. **`track_order` é sempre ao vivo** (1 requisição por pedido). Não peça
   rastreio de vários pedidos em rajada.
5. **O total confiável é `total`**, e as `priceLines` são o único breakdown que
   soma até ele. Os campos com nome (`subtotal`, `retail`, `saved`) são rótulos
   da Shein e não formam uma equação — não tente derivar um do outro.
6. **O número de parcelas não existe** nessa API. Existe `installmentFee` (o
   quanto o parcelamento custou). Se o usuário perguntar em quantas vezes,
   diga que a Shein não expõe isso.
7. **Pedido não pago ou cancelado não é gasto.** As tools já os excluem dos
   totais; ao narrar, não some por fora.
8. **Endereço só quando pedirem.** `get_order` só devolve o endereço com
   `include_address: true`, e é o endereço de casa do usuário: não repita em
   resumos.
9. **Pedido arquivado** (mais de um ano) responde com os valores da listagem,
   sem breakdown e sem nome de item — a Shein não manda mais que isso. Diga
   isso em vez de inventar.
10. **Devoluções:** `list_returns` sozinho lê o cache. Para afirmar que não
    houve nenhuma devolução, use `verify: true` — ele lê a aba do próprio site
    (1 requisição). Sem isso, diga apenas que não há nada registrado no cache.
11. **Bloqueio anti-bot: pare.** Se `auth_status` disser `breaker: tripped` ou
    vier um `cooldownUntil`, não tente de novo: peça ao usuário para abrir
    `br.shein.com`, resolver a verificação e refazer o login.

## Tools ↔ CLI

| Tool | CLI | Para quê |
| --- | --- | --- |
| `auth_status` | `shein auth [--verify]` | Estado da sessão; `verify` gasta 1 requisição |
| `login` | `shein login [--from-browser chrome]` | Abre o navegador ou importa a sessão |
| `doctor` | `shein doctor` | Qual camada quebrou (≤ 4 requisições) |
| `sync` | `shein sync [--full\|--reparse]` | Enche o cache, em blocos |
| `list_orders` | `shein orders` | Pedidos do cache, com filtros |
| `get_order` | `shein order <billno>` | Pedido inteiro, com breakdown |
| `track_order` | `shein track <billno>` | Rastreio ao vivo |
| `search_products` | `shein search <termo>` | Busca nos produtos comprados |
| `list_products` | `shein products` | Agregado por produto |
| `product_history` | `shein product-history <produto>` | Cada compra e a evolução do preço |
| `list_returns` | `shein returns [--verify]` | Devoluções; `verify` confere na aba do site |
| `spending_summary` | `shein spending --group-by …` | month, year, store, payment, breakdown |
| `export` | `shein export --format csv` | CSV/JSON em `SHEIN_EXPORT_DIR` |
| `raw_get` | `shein raw <path>` | Redescoberta; só leitura |

Todo comando do CLI aceita `--json`.

## Receitas

- *"Quanto gastei na Shein este ano?"* → `spending_summary` com
  `group_by: "year"` (ou `month` com `from`/`to`).
- *"Quanto foi de frete e imposto?"* → `spending_summary` com
  `group_by: "breakdown"`.
- *"Onde está meu pedido?"* → `list_orders` para achar o `billno`, depois
  `track_order`.
- *"Já comprei essa camisola antes?"* → `search_products`, e
  `product_history` para o preço de cada vez.
- *"Quanto custou o pedido X?"* → `get_order`, e leia `priceLines`.
- *"Quero isso numa planilha"* → `export` com `format: "csv"`.

## Avisos

- **Somente leitura.** Nenhuma tool altera a conta; `raw_get` recusa qualquer
  path de escrita.
- **Ritmo.** Uma requisição por vez, com pausa. Não paralelize por fora.
- **Dado pessoal.** Endereço, telefone e CPF só aparecem com
  `include_address`. Não os inclua em resumos nem em exemplos.
- **Arredondamento.** Valores saem em reais decimais; por dentro são centavos
  inteiros, então as somas fecham.
- Em `SHEIN_READ_ONLY=1`, `login`, `sync` e `export` não são registradas.
