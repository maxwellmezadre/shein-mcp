# Login

A Shein não tem OAuth de comprador. A autenticação é o cookie de sessão do seu
navegador, o mesmo que o site usa. Este projeto nunca vê a sua senha.

## Por que precisa de um navegador

O cookie de sessão é `HttpOnly`: `document.cookie` não o enxerga, e copiar o
que aparece ali à mão produz um jar que não autentica nada. Só o navegador
consegue entregá-lo (`context.cookies()`), e é por isso que o login existe como
comando, com dois caminhos.

## O caminho normal

```sh
shein login
```

Abre o Google Chrome em `br.shein.com/user/orders/list` com um perfil próprio
(`~/.config/shein-mcp/browser-profile`) e espera. Você entra normalmente:
senha, SMS, Google, captcha, o que a Shein pedir. O comando considera o login
concluído quando duas coisas acontecem: o cookie `memberId` aparece e a página
de pedidos renderiza os próprios dados (`gbRawData.order_list`). Só uma URL não
bastaria: a página de login também responde 200.

Opções: `--fresh` apaga o perfil antes (login do zero), `--timeout <segundos>`
muda a espera (default 300). `SHEIN_BROWSER_CHANNEL` troca o Chrome por
Chromium ou Edge.

## Importando de um navegador já logado (macOS)

```sh
shein login --from-browser chrome   # arc | chrome | chromium | brave | edge
```

É o caminho mais rápido se você já usa a Shein num desses navegadores. O
Chromium no macOS cifra os cookies com uma chave guardada no Keychain ("Chrome
Safe Storage"). O comando pede essa chave ao sistema (o macOS mostra o diálogo
de permissão uma vez), decifra os cookies da Shein e salva o jar. Nenhuma
janela é aberta e nenhuma senha é armazenada. `SHEIN_IMPORT_BROWSER` torna
isso o padrão do `login`.

Efeito colateral: a sessão passa a ser compartilhada com aquele navegador. Se
a Shein rotacionar um cookie de um lado, o outro pode expirar; importar de
novo resolve.

## O que é gravado, e onde

| Arquivo | Conteúdo |
| --- | --- |
| `~/.config/shein-mcp/session.enc` | O jar de cookies e o User-Agent, cifrados com AES-256-GCM (0600) |
| `~/.config/shein-mcp/session.key` | A chave, se você não definiu `SHEIN_SESSION_KEY` (0600) |
| `~/.config/shein-mcp/browser-profile/` | O perfil do Chrome de automação (0700), quando o login abriu janela |

## Ciclo de vida

Os cookies da Shein duram poucos dias. Quando expirarem, qualquer tool avisa e
o conserto é repetir o login. Se o servidor MCP estiver rodando, ele percebe o
arquivo novo sozinho: não precisa reiniciar. `shein status --verify` confirma
com uma requisição que a Shein ainda aceita a sessão.

## Revogando

```sh
rm ~/.config/shein-mcp/session.enc
```

E, para invalidar do lado da Shein, saia da conta no navegador (isso derruba a
sessão importada também).
