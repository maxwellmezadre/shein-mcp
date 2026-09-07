# ADR-0005 — Sessão por cookie, capturada do navegador

- **Status:** Aceito
- **Contexto:** a Shein não tem OAuth de comprador. O portal de
  desenvolvedores é para vendedores e não expõe o histórico da própria conta.

## Decisão

Autenticar com o jar de cookies do navegador do usuário, capturado de duas
formas: uma janela do Chrome controlada por `playwright-core`, ou a importação
dos cookies de um navegador já logado (macOS, via Keychain). A senha nunca
passa pelo projeto.

## Consequências

A sessão dura poucos dias e o conserto é refazer o login. Os cookies `HttpOnly`
só são capturáveis pelo navegador, então copiar `document.cookie` à mão não
funciona — e é por isso que o login existe como comando.
