# CLI

Todo comando roda a mesma tool que o servidor MCP expõe, então as duas
superfícies não podem divergir. `--json` funciona em qualquer comando (antes ou
depois do subcomando) e imprime exatamente o que o cliente MCP receberia.

## Sessão e diagnóstico

| Comando | Opções | O que faz |
| --- | --- | --- |
| `shein status` | `--verify` | Estado da sessão salva; `--verify` gasta 1 requisição |
| `shein login` | `--from-browser <nav>` `--fresh` `--timeout <s>` | Entra na conta ou importa a sessão |
| `shein doctor` | | Diagnostica sessão, endpoints e cache (≤ 4 requisições) |

## Cache

| Comando | Opções | O que faz |
| --- | --- | --- |
| `shein sync` | `--full` `--reparse` `--max-requests <n>` `--with-tracking` | Enche o cache, em blocos; repete sozinho até `done: true` |

## Pedidos

| Comando | Opções | O que faz |
| --- | --- | --- |
| `shein orders` | `--status` `--from` `--to` `--store` `--checkout` `--archived` `--limit` `--offset` `--compact` | Lista os pedidos do cache |
| `shein order <billno>` | `--include-address` `--compact` | Um pedido inteiro |
| `shein track <billno>` | `--limit-events <n>` | Rastreio ao vivo (1 requisição) |
| `shein search <termo>` | `--limit <n>` | Busca nos produtos comprados |
| `shein products` | `--store` `--category` `--from` `--to` `--limit` | Agregado por produto |
| `shein product-history <produto>` | | Cada compra e a evolução do preço |
| `shein returns` | `--verify` `--from` `--to` `--limit` | Devoluções; `--verify` lê a aba do site |

## Análise

| Comando | Opções | O que faz |
| --- | --- | --- |
| `shein spending` | `--by` `--from` `--to` | month \| year \| store \| payment \| breakdown |
| `shein export` | `--format` `--scope` `--out` | CSV ou JSON no diretório de exportação |

## Redescoberta

| Comando | Opções | O que faz |
| --- | --- | --- |
| `shein raw <path>` | `--query k=v` `--kind` `--max-bytes` | GET autenticado, só em superfícies de leitura |

## Servidor

| Comando | O que faz |
| --- | --- |
| `shein mcp` | Servidor MCP no stdio |

## Saída

Por padrão o resultado sai legível: pares chave/valor e tabelas alinhadas. Com
`--json`, sai o objeto cru, que é o que usar em scripts:

```sh
shein orders --limit 1 --json | jq -r '.orders[0].billno'
```

Um erro de tool sai no stderr e o processo termina com código diferente de
zero.

## Exemplos

```sh
# Quanto foi gasto em cada mês de 2026
shein spending --by month --from 2026-01-01 --to 2026-12-31

# Os pedidos de uma loja
shein orders --store "Amor E Arte lingerie"

# Todos os pedidos de uma mesma compra
shein orders --checkout USH…

# Redescoberta: o que a listagem responde hoje
shein raw /bff-api/order/list --query page=1 --query limit=20
```
