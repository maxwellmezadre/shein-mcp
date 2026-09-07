# O modelo de dados

Tudo que as tools respondem sai deste modelo (`src/domain/types.ts`). Por
dentro, **dinheiro é centavo inteiro**; a conversão para reais decimais
acontece só na borda (`src/tools/present.ts`), então nenhuma soma é feita em
float.

## Pedido

| Campo | O que é |
| --- | --- |
| `billno` | O número do pedido (`GSH…`). É a chave de tudo |
| `checkoutId` | `relation_billno`: agrupa os pedidos de **uma mesma compra** |
| `status` | `unpaid` \| `processing` \| `shipped` \| `delivered` \| `returned` \| `cancelled` \| `unknown` |
| `statusCode` / `statusLabel` | O código cru da Shein e o rótulo dela, sempre preservados |
| `placedAt` / `paidAt` | ISO em horário de Brasília (`-03:00`) |
| `money` | Os valores **com o nome que a Shein dá a eles** |
| `priceLines` | O breakdown que **soma até o total** |
| `items` | As linhas do pedido |
| `packages` | Os pacotes, quando houver rastreio |

Um checkout pode virar vários `billno`, e vários `billno` podem **dividir um
pacote**. Na conta que mapeou a API havia grupos de 3, 4, 5 e 7 pedidos.

## Dinheiro: as duas coisas que não se misturam

**`priceLines` é a aritmética.** São as linhas que a própria Shein mostra
(`sorted_price` com `show: "1"`), e a soma delas é exatamente `total` — isso foi
verificado em 21 de 21 pedidos reais, incluindo os internacionais. Tipos
observados: `newSubTotal`, `shipping`, `subTax` (aparece **duas** vezes:
Imposto de Importação e ICMS), `commission` (a taxa de parcelamento),
`shippingInsurance`, `onTimeInsurance`.

**`money` são rótulos.** `subtotal`, `retail`, `saved`, `shipping`, `tax`,
`installmentFee`, `coupon`, `points`, `wallet` são os campos que a Shein
publica com esses nomes. Eles **não formam uma equação**: num pedido
internacional, `money.subtotal` e a linha `newSubTotal` têm valores diferentes.
Use `priceLines` quando precisar que feche.

O que dá para afirmar sobre eles:

```
saved == (retail − subtotal) + (frete original − frete pago)
tax   == soma das linhas subTax
```

## O que não existe

- **O número de parcelas.** A API só carrega `installmentFee`, o quanto o
  parcelamento custou. A linha `PayDivide` existe, mas vem sempre zerada e
  oculta. Não invente esse número.
- **`isPaid` não serve**: vem `"0"` até em pedido pago. Quem diz é `pay_time`.
- **Pedido arquivado** (mais de um ano) responde o detalhe com um casco vazio:
  sem itens, sem breakdown, com os valores zerados. O dinheiro dele vem da
  listagem, e o item traz só id, imagem e quantidade — sem nome e sem preço.

## Item

`id` é a linha da própria Shein (a mesma que o rastreio chama de
`order_goods_id`), e é por ela que o item se liga ao pacote. O **nome** vem de
`product.goods_name`: no detalhe, `goods_name` vem vazio.

## Pacote

O rastreio mora em `packageMap`, indexado por `"0"`, `"1"`… `trackInfo` é uma
cópia da primeira entrada e **some** quando o pedido nunca foi enviado (8 de 21
páginas capturadas). Ler `packageMap` cobre todos os casos, inclusive o
multi-pacote.

Cada evento tem `at` (ISO), `description` (o texto do site, sem HTML) e
`place`. Os eventos vêm do mais recente para o mais antigo.

## Situação

O `orderStatus` da Shein é um número sem significado público. Os códigos vistos
numa conta real: `3` (não pago), `5` (entregue/avaliar), `10` (enviado). O enum
é **aberto**: um código desconhecido é lido pelos sinais em volta (pagou? tem
pacote? foi assinado?) e o código cru vai junto na resposta.
