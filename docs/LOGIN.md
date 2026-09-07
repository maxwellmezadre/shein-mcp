# Login

A Shein não tem OAuth de comprador. A autenticação é o cookie de sessão do seu
navegador — o mesmo que o site usa. Este projeto nunca vê a sua senha.

## Dois caminhos

### Importar de um navegador já logado (macOS)

```sh
shein login --from-browser chrome   # arc | chrome | chromium | brave | edge
```

O Chromium no macOS cifra os cookies com uma chave guardada no Keychain
("Chrome Safe Storage"). O comando pede essa chave ao sistema — o macOS mostra
o diálogo de permissão uma vez —, decifra os cookies da Shein e salva o jar.
Nenhuma janela é aberta e nenhuma senha é armazenada.

**Efeito colateral:** a sessão passa a ser compartilhada com aquele navegador.
Se a Shein rotacionar um cookie de um lado, o outro pode expirar; importar de
novo resolve.

### Abrir o navegador

```sh
shein login
```

Abre o Google Chrome em `br.shein.com/user/orders/list` com um perfil próprio
(`~/.config/shein-mcp/browser-profile`) e espera. Você entra normalmente —
senha, SMS, Google, captcha, o que a Shein pedir. O comando considera o login
concluído quando **duas** coisas acontecem: o cookie `memberId` aparece e a
página de pedidos renderiza os próprios dados (`gbRawData.order_list`). Só uma
URL não bastaria: a página de login também responde 200.

Opções: `--fresh` apaga o perfil antes (login do zero), `--timeout <segundos>`
muda a espera (default 300).

## O que fica salvo

| Arquivo | Conteúdo |
| --- | --- |
| `~/.config/shein-mcp/session.enc` | O jar de cookies e o User-Agent, cifrados com AES-256-GCM (0600) |
| `~/.config/shein-mcp/session.key` | A chave, se você não definiu `SHEIN_SESSION_KEY` (0600) |

Os cookies `HttpOnly` de sessão são capturados pelo navegador (`context.cookies()`),
não por `document.cookie` — copiar o `document.cookie` à mão produz um jar que
não autentica nada.

## Validade

Os cookies da Shein duram poucos dias. Quando expirarem, qualquer tool avisa e
o conserto é repetir o login. Se o servidor MCP estiver rodando, ele percebe o
arquivo novo sozinho: não precisa reiniciar.

## Revogar

```sh
rm ~/.config/shein-mcp/session.enc
```

E, para invalidar do lado da Shein, saia da conta no navegador (isso derruba a
sessão importada também).
