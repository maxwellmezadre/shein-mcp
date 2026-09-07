# Quando a Shein mudar

Vai mudar. Este documento é o roteiro para consertar sem adivinhação.

## 1. Pergunte ao doctor primeiro

```sh
shein doctor
```

Ele prova, em ordem: sessão, listagem, arquivados, detalhe, rastreio e cache,
e diz qual delas falhou e com qual mensagem. Gasta no máximo 4 requisições.

| Camada | Se falhar | Onde consertar |
| --- | --- | --- |
| `session` | Cookies expiraram ou o arquivo está ilegível | `shein login` |
| `order_list` | Endpoint, envelope ou parâmetros mudaram | `src/shein/api.ts` |
| `order_archive` | Idem, para os pedidos antigos | `src/shein/api.ts` |
| `order_detail` | Idem, ou o `info` mudou de forma | `src/shein/api.ts`, `src/domain/normalize.ts` |
| `order_track` | O bloco SSR mudou de nome ou de lugar | `src/shein/gbdata.ts`, `normalizePackages` |
| `cache` | Banco corrompido | Apague `~/.config/shein-mcp/cache.db` e rode `shein sync --full` |

## 2. Olhe a resposta crua

```sh
shein raw /bff-api/order/list --query page=1 --query limit=20
shein raw /orders/track --query billno=GSH… --kind html --max-bytes 4000
```

`raw_get` usa os mesmos cookies, o mesmo ritmo e o mesmo breaker das outras
tools, e recusa qualquer path que possa escrever na conta.

## 3. Recapture o corpus

```sh
SHEIN_TRANSPORT=fetch bun run scripts/capture-fixtures.ts --write
```

Grava tudo em `task/captures/` (gitignored, 0600): listagem, arquivados,
detalhe e rastreio de cada pedido, a busca, os probes de "não logado", e
registra qual transporte serviu cada captura. Rodar com `SHEIN_TRANSPORT=fetch`
é o que torna observável a afirmação "o replay HTTP puro ainda funciona".

Depois:

```sh
bun test test/local     # o corpus dourado sobre as capturas cruas
bun run scripts/anonymize-fixture.ts --write
bun test                # a suíte inteira, agora sobre os fixtures novos
```

O anonimizador falha se qualquer valor original sobreviver. Ele nunca toca em
dinheiro, quantidade ou data.

## 4. Se mudou o parser

Incremente `PARSER_VERSION` em `src/cache/sync.ts`. O próximo `sync` reprocessa
todo o histórico a partir do payload salvo, sem rede:

```sh
shein sync --reparse
```

## 5. Se a Shein passar a exigir assinatura

Os endpoints de pedido hoje respondem só com cookie. Se um dia devolverem
veredito anti-bot, não tente reimplementar `armorToken`: rode com

```sh
SHEIN_TRANSPORT=browser shein sync
```

que executa as mesmas requisições dentro de um Chrome headless com a sua
sessão; a assinatura é do próprio site. Com `auto` (o padrão), essa troca
acontece sozinha na primeira negativa.

## 6. Se precisar filtrar por aba

O JSON ignora `status_type`. Quem filtra é a página:

```sh
shein raw /user/orders/list --query status_type=4 --kind html --max-bytes 2000
```

`status_type`: 0 todos, 1 não pago, 2 processando, 3 enviado, 5 avaliar,
4 devolução/reembolso.

## 7. Se a resposta mudar de forma

Mude `src/domain/normalize.ts`, o único arquivo que conhece nomes de campo da
Shein, e escreva o teste antes, sobre o fixture novo. `test/normalize.test.ts`
e `test/local/captures.local.test.ts` já cobrem as identidades que precisam
continuar verdadeiras.

## Nunca automatize

- O login e a verificação anti-bot. Quem digita senha, código e captcha é o
  usuário, numa janela visível. Automatizar isso é o que faz a Shein marcar a
  conta.
- A assinatura `armorToken`. Se ela passar a ser exigida, o transporte
  `browser` deixa o site assinar; reimplementá-la é frágil e chama atenção.
- Qualquer escrita na conta: cancelar, devolver, confirmar entrega. `raw_get`
  recusa esses paths por construção, e nenhuma tool nova deve abrir essa porta.
- Requisições em paralelo. Um `sync` de cada vez, com o intervalo padrão.
