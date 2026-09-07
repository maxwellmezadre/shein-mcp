# ADR-0007: Dinheiro em centavos inteiros

## Contexto

Status: aceito.

O projeto existe para somar dinheiro. `0.1 + 0.2` em float não
é `0.3`, e um relatório de gastos errado por um centavo é um relatório em que
não se confia.

## Decisão

Centavo inteiro em toda parte por dentro: no domínio, nas colunas do SQLite
(`*_cents`) e nas somas. A conversão para decimal acontece só na borda da tool
(`src/tools/present.ts`). A leitura usa `Math.round`, nunca truncamento.

## Consequências

`SUM()` no SQLite é exato. Em compensação, todo campo de dinheiro novo precisa
lembrar do sufixo `_cents` e da conversão na saída.
