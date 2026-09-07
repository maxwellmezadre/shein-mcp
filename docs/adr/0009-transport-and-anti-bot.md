# ADR-0009 — Cookie basta hoje; navegador é o plano B

- **Status:** Aceito
- **Contexto:** a Shein assina as chamadas de catálogo com `armorToken`,
  `anti-in` e `smdeviceid`, derivadas de fingerprint do navegador. Mas os
  endpoints de pedido (`/bff-api/order/*`) responderam **sem nenhum desses
  headers**: 21 pedidos, 54 requisições, replay HTTP puro pelo Bun com os
  cookies importados, zero veredito anti-bot (2026-09-07).

## Decisão

O transporte padrão é HTTP puro. `SHEIN_TRANSPORT=auto` troca **uma vez**, no
primeiro veredito de risco, para um Chrome headless que abre a própria página
de pedidos com a sessão injetada e executa os mesmos `fetch` de dentro dela.
Um segundo veredito arma o breaker e grava um cooldown de 30 minutos que
sobrevive ao processo.

A assinatura anti-bot **nunca** é reimplementada. Quem assina, se preciso, é o
site.

## Consequências

O caminho normal é barato (nenhum navegador, ~100 KB por página JSON contra
1–2 MB das páginas SSR). O plano B custa uns 5 segundos na primeira chamada e
exige o Chrome instalado. `playwright-core` é dependência normal, não opcional:
o binário compilado também precisa do plano B. O compile leva
`--external chromium-bidi` — é um `require` dinâmico que o bundler não resolve,
e o caminho que o usa (transporte BiDi) não é o nosso: o Chrome fala CDP.
