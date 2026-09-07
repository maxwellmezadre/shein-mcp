# Segurança

## O modelo de ameaça

O jar de cookies é a conta inteira. Quem tiver `session.enc` e a chave ao lado
dele consegue ler seu histórico de compras, seu endereço e seu CPF.

| Proteção | Como |
| --- | --- |
| Sessão cifrada em repouso | AES-256-GCM, arquivo 0600, escrita atômica |
| Chave separada | `SHEIN_SESSION_KEY` ou `session.key` (0600), gerada na primeira gravação |
| Cache 0600 | O `cache.db` guarda o histórico; nasce com `umask 0o077` |
| Nada de escrita na conta | Nenhuma tool altera nada, e `raw_get` recusa paths de escrita |
| Endereço sob demanda | Só sai de `get_order` com `include_address: true`; nunca é projetado numa coluna |
| Redação nos logs | Valores de cookie nunca aparecem numa linha de log |
| Exportação confinada | `export` só escreve em `SHEIN_EXPORT_DIR`, e o nome do arquivo é reduzido ao basename |
| Anti-bot | Uma requisição por vez, com intervalo. Um veredito de risco troca o transporte uma vez; o segundo arma o breaker e grava um cooldown de 30 minutos que sobrevive ao processo |
| Fixtures públicos | Anonimização determinística com guarda de vazamento no CI |

## Nunca faça

- Não cole `session.enc`, `session.key`, `cache.db` nem um header `Cookie` numa
  issue. Eles são a sua conta.
- Não commite nada de `task/`: é onde ficam as capturas cruas.
- Não reduza `SHEIN_MIN_INTERVAL_MS` a zero. O ritmo é o que evita o bloqueio
  anti-bot.

## Revogando uma sessão

```sh
rm ~/.config/shein-mcp/session.enc
```

Para invalidar também do lado da Shein, saia da conta no navegador.

## Reportando

Não abra uma issue pública para uma vulnerabilidade. Reporte por
[GitHub Security Advisories](https://github.com/maxwellmezadre/shein-mcp/security/advisories/new).
