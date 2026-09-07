# Fixtures

Respostas **reais** da conta do autor, capturadas em 2026-09-07 em `br.shein.com`
e **anonimizadas deterministicamente** por `scripts/anonymize-fixture.ts` antes de
entrar no repositório (que é público).

| Arquivo | Origem |
| --- | --- |
| `order-list.json` | `GET /bff-api/order/list` (página 1, 3 pedidos) |
| `order-archive.json` | `GET /bff-api/order/get_order_archive_list` (pedido com mais de um ano) |
| `order-detail.json` | `GET /bff-api/order/get_order_detail` (nacional, com seguro de envio) |
| `order-detail-tax.json` | idem, pedido internacional: traz as duas linhas `subTax` |
| `order-detail-archived.json` | idem, pedido arquivado: responde, mas com os valores zerados |
| `track.json` | `var gbOrdersTrackSsrData` de `GET /orders/track?billno=…` |
| `unauth-list.json` | o envelope que a lista devolve a quem não está logado |

## O que a anonimização faz

- **Ids** (`billno`, pacote, rastreio, `goods_sn`, `sku_code`, `store_code`, `memberId`…):
  remapeados por `sha256(salt + valor)` mantendo prefixo e comprimento, e trocados no
  arquivo inteiro — então **as relações sobrevivem**: o `billno` do detalhe continua
  sendo um da lista, e o pacote do pedido continua sendo o do rastreio.
- **Dinheiro, quantidades e datas nunca são tocados.** Ids são trocados por nome de
  campo, nunca por "qualquer sequência longa de dígitos": um timestamp unix tem 10
  dígitos e remapeá-lo destruiria todas as datas. A identidade que o normalizador usa
  continua verdadeira aqui: `total == soma das linhas de sorted_price com show=1`.
- **PII** (nome, telefone, endereço, CEP, CPF, cidade, e-mail) trocada por
  placeholders fixos, por palavra-chave no nome do campo — o endereço de entrega, o de
  cobrança e a página de rastreio chamam as mesmas coisas de nomes diferentes.
- **Nome de produto e de loja** viram pseudo-palavras de um dicionário, por hash.
- Blocos volumosos e inúteis para os testes (dicionários de tradução, A/B, banners)
  são removidos.

`test/fixtures.test.ts` é a guarda permanente: falha se e-mail, CEP, CPF ou nome real
aparecer aqui.

## Corpus completo

As capturas cruas ficam em `task/captures/` (gitignored, 0600) e alimentam
`test/local/captures.local.test.ts`, que se auto-ignora quando a pasta não existe.
