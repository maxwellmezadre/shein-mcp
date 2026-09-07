# Tools

> Gerado por `bun run docs:tools` a partir de `src/tools/registry.ts`. Não edite à mão.

São 14 tools. As marcadas como somente leitura continuam disponíveis com
`SHEIN_READ_ONLY=1`; as outras simplesmente não são registradas nesse modo.

| Tool | Somente leitura | O que faz |
| --- | --- | --- |
| [`auth_status`](#authstatus) | sim | Diz se há uma sessão da Shein salva e o que ela cobre (memberId, idade, validade dos cookies, transporte, bloqueio anti-bot). |
| [`login`](#login) | não | Abre uma janela do Google Chrome para o usuário entrar na conta da Shein e guarda a sessão cifrada (a senha nunca passa por aqui). |
| [`doctor`](#doctor) | sim | Diagnostica a instalação de ponta a ponta: sessão, listagem de pedidos, pedidos arquivados, detalhe, rastreio e cache local. |
| [`sync`](#sync) | não | Baixa o histórico da Shein para o cache local, em blocos. |
| [`list_orders`](#listorders) | sim | Lista os pedidos da Shein já baixados para o cache, do mais novo para o mais antigo, com filtros por situação, período, loja e checkout. |
| [`get_order`](#getorder) | sim | Detalhe completo de um pedido da Shein: itens, preços, o breakdown que soma o total (subtotal, frete, imposto, taxa de parcelamento), pagamento, pacotes e situação. |
| [`track_order`](#trackorder) | sim | Rastreio de um pedido da Shein, sempre ao vivo (1 requisição): transportadora, código de rastreio e a linha do tempo do pacote, do evento mais recente para o mais antigo. |
| [`search_products`](#searchproducts) | sim | Busca entre os produtos que o usuário JÁ COMPROU na Shein (não é busca no catálogo). |
| [`list_products`](#listproducts) | sim | Lista os produtos comprados agregados por produto: quantas vezes, quantas unidades, quanto foi gasto no total e o preço unitário mínimo e máximo. |
| [`product_history`](#producthistory) | sim | Todas as compras de um produto, da mais antiga para a mais nova, com a evolução do preço unitário. |
| [`list_returns`](#listreturns) | sim | Lista os itens com devolução ou reembolso registrados no detalhe do pedido. |
| [`spending_summary`](#spendingsummary) | sim | Quanto o usuário gastou na Shein, agrupado por mês, ano, loja, meio de pagamento ou componente do preço. |
| [`export`](#export) | não | Exporta o cache para um arquivo CSV ou JSON, com os pedidos ou os itens. |
| [`raw_get`](#rawget) | sim | Faz um GET autenticado em uma superfície de pedidos da Shein (bff-api/order/*, leituras de bff-api/order-api/order/*, páginas SSR /user/orders/* e /orders/track), com o mesmo limite de taxa das outras tools. |

## auth_status

Diz se há uma sessão da Shein salva e o que ela cobre (memberId, idade, validade dos cookies, transporte, bloqueio anti-bot). Não usa a rede por padrão. Com verify=true gasta 1 requisição para confirmar que a Shein ainda aceita a sessão. Comece por aqui quando outra tool reclamar de sessão.

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `verify` | boolean | não | Também faz 1 chamada à Shein para confirmar que a sessão é aceita |

## login

Abre uma janela do Google Chrome para o usuário entrar na conta da Shein e guarda a sessão cifrada (a senha nunca passa por aqui). Bloqueia até o login terminar — até 15 minutos. Com from_browser (ou SHEIN_IMPORT_BROWSER), importa a sessão de um navegador já logado (Arc, Chrome… só macOS) em vez de abrir a janela. Prefira o comando de terminal `shein login` quando o cliente MCP tiver timeout curto.

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `timeout_seconds` | integer | não | Tempo máximo esperando o login (default 300) |
| `fresh` | boolean | não | Apaga o perfil do navegador de automação antes (login do zero; no import, a Shein passa a ver um dispositivo novo) |
| `from_browser` | arc \| chrome \| chromium \| brave \| edge | não | Importa os cookies de um navegador já logado (só macOS) em vez de abrir uma janela |

## doctor

Diagnostica a instalação de ponta a ponta: sessão, listagem de pedidos, pedidos arquivados, detalhe, rastreio e cache local. Diz qual camada quebrou quando a Shein muda alguma coisa — rode antes de reportar um problema. Gasta no máximo 4 requisições.

Sem parâmetros.

## sync

Baixa o histórico da Shein para o cache local, em blocos. Gasta no máximo `max_requests` requisições por chamada e devolve `done: false` quando ainda falta — nesse caso chame de novo com os mesmos parâmetros até `done: true`. `incremental` (padrão) para no primeiro trecho sem novidade; `full` varre tudo de novo; `reparse` reprocessa o que já está salvo sem usar a rede. Depois disso, list_orders, get_order e spending_summary respondem sem tocar na Shein.

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `mode` | incremental \| full \| reparse | não | incremental (default) | full | reparse (sem rede) |
| `max_requests` | integer | não | Teto de requisições nesta chamada (default 60) |
| `with_tracking` | boolean | não | Também busca o rastreio dos pedidos enviados (1 requisição por pedido) |

## list_orders

Lista os pedidos da Shein já baixados para o cache, do mais novo para o mais antigo, com filtros por situação, período, loja e checkout. Não usa a rede: rode `sync` antes se o cache estiver vazio. Use para 'meus últimos pedidos', 'o que comprei em agosto', 'pedidos da loja X'.

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `status` | unpaid \| processing \| shipped \| delivered \| returned \| cancelled \| unknown | não | Filtra por situação do pedido |
| `from` | string | não | Início do período, YYYY-MM-DD (inclusivo) |
| `to` | string | não | Fim do período, YYYY-MM-DD (inclusivo) |
| `store` | string | não | Nome exato da loja, como aparece nos itens |
| `checkout_id` | string | não | Agrupa os pedidos de uma mesma compra (relation billno) |
| `archived` | boolean | não | Só pedidos arquivados (mais de um ano) |
| `limit` | integer | não | Máximo de itens (default 20) |
| `offset` | integer | não | Itens a pular (paginação) |
| `compact` | boolean | não | Devolve apenas os campos essenciais, para economizar contexto (default SHEIN_COMPACT) |

## get_order

Detalhe completo de um pedido da Shein: itens, preços, o breakdown que soma o total (subtotal, frete, imposto, taxa de parcelamento), pagamento, pacotes e situação. Responde do cache; se o pedido não estiver lá, gasta 1 requisição e guarda o resultado. O endereço de entrega só vem com include_address=true.

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `billno` | string | sim | Número do pedido na Shein (billno, ex.: GSH1…), como aparece em `list_orders` |
| `include_address` | boolean | não | Inclui o endereço de entrega (dado pessoal; default false) |
| `compact` | boolean | não | Devolve apenas os campos essenciais, para economizar contexto (default SHEIN_COMPACT) |

## track_order

Rastreio de um pedido da Shein, sempre ao vivo (1 requisição): transportadora, código de rastreio e a linha do tempo do pacote, do evento mais recente para o mais antigo. Vários pedidos da mesma compra podem dividir um pacote. Um pedido que ainda não foi enviado responde sem pacotes.

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `billno` | string | sim | Número do pedido na Shein (billno, ex.: GSH1…), como aparece em `list_orders` |
| `limit_events` | integer | não | Máximo de eventos por pacote (default todos) |

## search_products

Busca entre os produtos que o usuário JÁ COMPROU na Shein (não é busca no catálogo). Ignora acentos e maiúsculas e olha nome, cor/tamanho e loja. Não usa a rede. Use para 'quando comprei aquele conjunto', 'quanto paguei na calcinha', 'já comprei isso antes?'.

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `query` | string | sim | Palavras do produto, como o usuário lembra |
| `limit` | integer | não | Máximo de itens (default 20) |

## list_products

Lista os produtos comprados agregados por produto: quantas vezes, quantas unidades, quanto foi gasto no total e o preço unitário mínimo e máximo. Do maior gasto para o menor, sem usar a rede. Pedidos não pagos e cancelados ficam de fora.

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `store` | string | não | Nome exato da loja |
| `category` | string | não | cat_id da Shein |
| `from` | string | não | Início do período, YYYY-MM-DD (inclusivo) |
| `to` | string | não | Fim do período, YYYY-MM-DD (inclusivo) |
| `limit` | integer | não | Máximo de itens (default 50) |

## product_history

Todas as compras de um produto, da mais antiga para a mais nova, com a evolução do preço unitário. Aceita o goods_id ou palavras do nome (nesse caso usa o produto mais comprado que casar). Pedidos não pagos e cancelados aparecem na lista, mas não entram no total gasto. Responde do cache, sem rede.

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `product` | string | sim | goods_id da Shein ou palavras do nome do produto |

## list_returns

Lista os itens com devolução ou reembolso registrados no detalhe do pedido. A Shein não expõe um histórico de devoluções que este projeto consiga ler, então aqui aparece só o que vem no pedido — se estiver vazio, não significa que nunca houve devolução. Não usa a rede.

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `from` | string | não | Início do período, YYYY-MM-DD (inclusivo) |
| `to` | string | não | Fim do período, YYYY-MM-DD (inclusivo) |
| `limit` | integer | não | Máximo de itens (default 50) |

## spending_summary

Quanto o usuário gastou na Shein, agrupado por mês, ano, loja, meio de pagamento ou componente do preço. Responde do cache, sem rede. Pedidos não pagos e cancelados nunca entram na conta. Use para 'quanto gastei este ano', 'quanto foi de frete', 'qual loja levou mais dinheiro'.

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `group_by` | month \| year \| store \| payment \| breakdown | não | month (default) | year | store | payment | breakdown |
| `from` | string | não | Início do período, YYYY-MM-DD (inclusivo) |
| `to` | string | não | Fim do período, YYYY-MM-DD (inclusivo) |

## export

Exporta o cache para um arquivo CSV ou JSON, com os pedidos ou os itens. Grava sempre dentro de SHEIN_EXPORT_DIR (default ~/Downloads/shein-export) e devolve o caminho. Valores saem em reais decimais, prontos para planilha.

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `format` | csv \| json | não | csv (default) | json |
| `scope` | orders \| items | não | orders (default) | items |
| `filename` | string | não | Nome do arquivo (só o nome: o diretório é sempre o de exportação) |

## raw_get

Faz um GET autenticado em uma superfície de pedidos da Shein (bff-api/order/*, leituras de bff-api/order-api/order/*, páginas SSR /user/orders/* e /orders/track), com o mesmo limite de taxa das outras tools. Serve para redescobrir um endpoint quando o site muda — use com parcimônia e nunca em rajada. Qualquer path que possa alterar a conta é recusado: este servidor é somente leitura.

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `path` | string | sim | Path absoluto, ex.: /bff-api/order/list |
| `query` | object | não | Query string extra. `_ver` e `_lang` são preenchidos automaticamente nas chamadas JSON. |
| `kind` | json \| html | não | json (default) devolve o envelope {code,msg,info}; html devolve a página como texto |
| `max_bytes` | integer | não | Corta a resposta neste tamanho (default 65536) |

