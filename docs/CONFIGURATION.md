# Configuração

Tudo vem do ambiente (12-factor, prefixo `SHEIN_`). Nenhum arquivo `.env` é
lido. A configuração é validada na partida e, se algo estiver errado, o erro
lista todos os problemas de uma vez.

## Variáveis

| Variável | Default | O que faz |
| --- | --- | --- |
| `SHEIN_CONFIG_DIR` | `~/.config/shein-mcp` | Diretório de tudo que é persistido |
| `SHEIN_SESSION_KEY` | — | Base64 de 32 bytes. Sem ela, uma chave é gerada em `session.key` |
| `SHEIN_EXPORT_DIR` | `~/Downloads/shein-export` | O único diretório onde `export` escreve |
| `SHEIN_READ_ONLY` | `0` | Não registra `login`, `sync` e `export` |
| `SHEIN_COMPACT` | `0` | Respostas mínimas por padrão nas tools que aceitam `compact` |
| `SHEIN_BROWSER_CHANNEL` | `chrome` | `chrome` \| `chromium` \| `msedge` |
| `SHEIN_IMPORT_BROWSER` | — | Navegador padrão do `login` sem janela (só macOS) |
| `SHEIN_MIN_INTERVAL_MS` | `1000` | Intervalo mínimo entre requisições |
| `SHEIN_JITTER_MS` | `500` | Variação aleatória somada ao intervalo |
| `SHEIN_HTTP_TIMEOUT_MS` | `30000` | Timeout de cada requisição |
| `SHEIN_LOG_FILE` | — | Espelha os logs (que vão sempre para stderr) num arquivo |
| `SHEIN_LIVE` | — | `=1` destrava o teste de integração contra a conta real (`bun test test/integration`) |
| `SHEIN_BASE_URL` | `https://br.shein.com` | A loja. Outro país muda aqui |
| `SHEIN_LANG` | `pt-br` | `_lang` de toda chamada JSON: decide o idioma dos rótulos |
| `SHEIN_TRANSPORT` | `auto` | `auto` (HTTP e, se bloquear, navegador) \| `fetch` \| `browser` |

`~/` é expandido à mão nos caminhos: a configuração de um cliente MCP é JSON,
não shell.

## Arquivos em disco

Tudo dentro de `SHEIN_CONFIG_DIR`:

| Arquivo | Modo | O que é |
| --- | --- | --- |
| `session.enc` | 0600 | O jar de cookies, cifrado com AES-256-GCM |
| `session.key` | 0600 | A chave, quando não vem de `SHEIN_SESSION_KEY` |
| `cache.db` | 0600 | O cache SQLite (WAL) |
| `browser-profile/` | 0700 | Perfil do Chrome de automação (login e transporte `browser`) |

O jar de cookies é a conta. Trate `session.enc` e `session.key` como
credenciais: veja [SECURITY.md](../SECURITY.md).

## Registro no Claude Code

`bun run setup` faz isso. À mão, no escopo de usuário (vale em todo projeto):

```sh
claude mcp add -s user shein -- /Users/voce/.local/bin/shein mcp
```

Variante somente leitura, para um agente menos confiável:

```sh
claude mcp add -s user shein --env SHEIN_READ_ONLY=1 -- /Users/voce/.local/bin/shein mcp
```

Claude Desktop ou qualquer cliente que leia `mcpServers`:

```json
{
  "mcpServers": {
    "shein": {
      "type": "stdio",
      "command": "/Users/voce/.local/bin/shein",
      "args": ["mcp"],
      "env": { "SHEIN_IMPORT_BROWSER": "chrome" }
    }
  }
}
```

Use o caminho absoluto: clientes MCP não herdam o `PATH` do shell.

## Ritmo e anti-bot

O default é ~1 a 1,5 s por requisição, uma de cada vez. Não é conservadorismo
gratuito: os projetos irmãos desta família levaram bloqueio anti-bot exatamente
por rajadas de requisições paralelas. Uma sincronização completa de uma conta
com 20 pedidos custa cerca de 25 requisições.

No primeiro veredito de risco da Shein, o transporte `auto` troca para um
Chrome headless que executa as mesmas chamadas de dentro da página. No
segundo, o breaker desarma o cliente pelo resto do processo e grava um
cooldown de 30 minutos no cache, respeitado por qualquer processo novo;
`shein status` mostra `cooldownUntil`. Sair disso exige ação humana: resolver
a verificação no navegador e refazer o login.
