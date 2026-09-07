# ADR-0006: Sessão cifrada em repouso

## Contexto

Status: aceito.

O jar de cookies **é a conta**. Deixá-lo em texto puro no
`$HOME` é o pior tipo de conveniência.

## Decisão

AES-256-GCM. O arquivo é `[versão][IV 12B][tag 16B][ciphertext]`, escrito 0600
por rename atômico. A chave vem de `SHEIN_SESSION_KEY` ou de um `session.key`
gerado na primeira gravação, também 0600.

## Consequências

Não protege contra alguém que já tem seu usuário (a chave está ao lado), mas
tira os cookies de backups, de `grep` e de qualquer leitura casual. Uma chave
trocada dá um erro claro em vez de lixo decifrado.
