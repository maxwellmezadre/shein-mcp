# ADR-0010: `billno` é a chave; `relation_billno` é a compra

## Contexto

Status: aceito.

Uma compra na Shein vira **vários** pedidos. Na conta que mapeou
a API, um mesmo `relation_billno` cobria grupos de 3, 4, 5 e 7 `billno`, e
vários deles dividiam **um único pacote**.

## Decisão

`billno` é a chave primária de tudo: cache, tools, rastreio. `relation_billno`
vira `checkoutId`, um campo indexado que agrupa. O pacote é gravado **por
pedido** (`packages` tem chave `(billno, package_no)`), porque a mesma encomenda
aparece legitimamente em vários pedidos.

## Consequências

"Quanto custou essa compra" pode precisar de `list_orders --checkout <id>` em
vez de um pedido só. Em troca, nada é agrupado errado: cada pedido tem o próprio
total, o próprio status e a própria devolução.
