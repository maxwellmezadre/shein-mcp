# CLI

Todo comando roda a **mesma** tool que o servidor MCP expõe, então as duas
superfícies não podem divergir. `--json` funciona em qualquer comando (antes ou
depois do subcomando) e imprime exatamente o que o cliente MCP receberia.

| Comando | Opções | O que faz |
| --- | --- | --- |
| `shein auth` | `--verify` | Estado da sessão salva |
| `shein login` | `--from-browser <nav>` `--fresh` `--timeout <s>` | Entra na conta ou importa a sessão |
| `shein doctor` | | Diagnostica sessão, endpoints e cache |
| `shein sync` | `--full` `--reparse` `--max-requests <n>` `--with-tracking` | Enche o cache, em blocos |
| `shein orders` | `--status` `--from` `--to` `--store` `--checkout` `--archived` `--limit` `--offset` `--compact` | Lista os pedidos do cache |
| `shein order <billno>` | `--include-address` `--compact` | Um pedido inteiro |
| `shein track <billno>` | `--limit-events <n>` | Rastreio ao vivo |
| `shein search <termo>` | `--limit <n>` | Busca nos produtos comprados |
| `shein products` | `--store` `--category` `--from` `--to` `--limit` | Agregado por produto |
| `shein product-history <produto>` | | Cada compra e a evolução do preço |
| `shein returns` | `--from` `--to` `--limit` | Devoluções registradas |
| `shein spending` | `--group-by` `--from` `--to` | month \| year \| store \| payment \| breakdown |
| `shein export` | `--format` `--scope` `--out` | CSV ou JSON no diretório de exportação |
| `shein raw <path>` | `--query k=v` `--kind` `--max-bytes` | GET autenticado (redescoberta) |
| `shein mcp` | | Servidor MCP no stdio |

## Saída

Por padrão o resultado sai legível: pares chave/valor e tabelas alinhadas. Com
`--json`, sai o objeto cru — é o que usar em scripts:

```sh
shein orders --limit 1 --json | jq -r '.orders[0].billno'
```

## Exemplos

```sh
# Quanto foi gasto em cada mês de 2026
shein spending --group-by month --from 2026-01-01 --to 2026-12-31

# Os pedidos de uma loja
shein orders --store "Amor E Arte lingerie"

# Todos os pedidos de uma mesma compra
shein orders --checkout USH…

# Redescoberta: o que a listagem responde hoje
shein raw /bff-api/order/list --query page=1 --query limit=20
```
