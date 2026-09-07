# A API interna da Shein

Engenharia reversa validada contra uma conta real em `br.shein.com`
(2026-09-07: 21 pedidos, 54 requisições). Os ids abaixo são placeholders. Nada
aqui é documentado ou estável — quando mudar,
[`REDISCOVERY.md`](REDISCOVERY.md) diz como remapear.

## Por que não existe caminho oficial

O portal de desenvolvedores da Shein é para **vendedores**. Não há OAuth de
comprador, nem access token, nem qualquer endpoint público do histórico da sua
própria conta. O único caminho é a API interna que o site usa, autenticada
pelos cookies da sessão — exatamente como a página `/user/orders/list` faz.

## Autenticação

Só cookies. O cookie de sessão é `HttpOnly` (não aparece em `document.cookie`);
o `memberId` é visível e serve como sinal barato de "está logado". Não há
assinatura em nenhuma das chamadas abaixo.

> A Shein **assina** as chamadas de catálogo com `armorToken`, `anti-in`,
> `smdeviceid` e `x-gw-auth`, derivadas de fingerprint do navegador. Os
> endpoints de pedido deste documento responderam sem nenhum desses headers.
> Este projeto **nunca** reimplementa essa assinatura: se um dia ela passar a
> ser exigida, o transporte `browser` deixa o próprio site assiná-la
> ([ADR-0009](adr/0009-transport-and-anti-bot.md)).

## Endpoints

Todos GET. As chamadas JSON levam sempre `_ver=1.1.8` e `_lang=pt-br`.

| # | Endpoint | Resposta |
| --- | --- | --- |
| 1 | `/bff-api/order/list?page&limit&status_type` | `{code:"0", msg:"ok", info:{order_list, sum, orderStatusList, sum_filed_orders, …}}` |
| 2 | `/bff-api/order/get_order_archive_list?page&limit` | Idem, com os pedidos de mais de um ano (shape reduzido) |
| 3 | `/bff-api/order/get_order_detail?billno` | `info` com ~378 chaves: itens, `sorted_price`, pagamento, endereço |
| 4 | `/orders/track?billno` | HTML; os dados estão em `var gbOrdersTrackSsrData = {…}` |
| 5 | `/user/orders/list?page&status_type` | HTML; os dados estão em `var gbRawData = {…}`. **É a única superfície que filtra por aba** |
| 5b | `/user/orders/detail/<billno>` | HTML; idem, com `orderInfo` |
| 6 | `/bff-api/order/search_order_goods?keyword&page&limit` | Shape da listagem, filtrado pelo servidor |

## O envelope

```json
{ "code": "0", "msg": "ok", "info": { } }
```

Qualquer `code` diferente de `"0"` é erro. Dois que importam:

- **`00101001`** — é o que um chamador **deslogado** recebe… e também o que um
  parâmetro ou método errado recebe. É ambíguo, então **não** marca a sessão
  como morta: vira um erro de API com uma dica, e `auth_status` é quem
  classifica.
- **`100102`** — "Erro ao solicitar o parâmetro".

## Armadilhas confirmadas

1. **`limit` satura em 20.** Pedir 50 devolve 20.
2. **`status_type` é ignorado pelo JSON, mas respeitado pelo SSR.** Em
   `/bff-api/order/list` todas as abas devolvem a página idêntica, byte a byte.
   Já `/user/orders/list?status_type=N` filtra de verdade — foi assim que se
   confirmou que a conta não tem nenhuma devolução (aba 4 com `sum: 0`), e que
   códigos e abas não são a mesma coisa (verificado 2026-09-07: 20 pedidos, com
   0 em "Não pago", 0 em "Enviado" e 9 em "Avaliar").
3. **Toda página tem um link de login no cabeçalho** ("Já sou cliente"). Usar
   isso para detectar sessão morta é um falso positivo garantido — foi o que
   matou a primeira captura completa. O sinal confiável é o **redirect 302**.
4. **`total` = soma de `sorted_price` com `show:"1"`.** Os campos nomeados não
   fecham entre si.
5. **`packageMap` é a fonte do rastreio**, não `trackInfo` (que some em pedidos
   não enviados).
6. **Pedido arquivado** responde `get_order_detail` com um casco vazio.
7. **`paymentTime` é milissegundos**; `addTime` e `pay_time`, segundos.

## Devoluções

`/bff-api/order-api/order/get_return_and_refund_list` recusou GET com
`00101001` e POST com `100102` em três formatos de parâmetro — continua sem
mapear. **Não faz falta:** a aba "Devolução/Reembolso" é
`/user/orders/list?status_type=4`, e o SSR filtra de verdade. É o que
`list_returns --verify` usa, e é o que permite afirmar que não houve nenhuma
devolução em vez de só não ter encontrado.

## As abas

`orderStatusList` traz os ids: `0` todos, `1` não pago, `2` processando,
`3` enviado, `5` avaliar, `4` devolução/reembolso. Eles são o **estado atual**,
não o histórico: um pedido entregue há meses não aparece em "Enviado", e o
`orderStatus` dele pode continuar sendo `10` ("Enviado") para sempre. Por isso
a situação é lida por sinais, não pelo código — ver
[`DATA-MODEL.md`](DATA-MODEL.md).
