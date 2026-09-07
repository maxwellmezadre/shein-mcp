# Do zero à primeira resposta

## 1. Instalar

```sh
git clone https://github.com/maxwellmezadre/shein-mcp.git
cd shein-mcp
bun install
bun run setup
```

## 2. Entrar na conta

```sh
shein login --from-browser chrome
```

Se você já usa a Shein no Chrome, isso lê os cookies pelo Keychain (o macOS
pede permissão uma vez) e não abre janela. Sem isso:

```sh
shein login
```

abre o Chrome, você entra normalmente e a sessão é salva cifrada quando a
página de pedidos aparecer.

Confira:

```sh
shein status --verify
```

## 3. Baixar o histórico

```sh
shein sync
```

Se responder `done: false`, rode de novo até `done: true`; o trabalho já feito
fica salvo. Para trazer o rastreio junto:

```sh
shein sync --with-tracking
```

## 4. Perguntar

```sh
shein spending --by month
shein spending --by breakdown             # produto, frete, imposto, parcelamento
shein orders --status delivered --limit 5
shein search "camisola"
shein product-history "camisola"
shein order GSH…                          # o pedido inteiro
shein track GSH…                          # rastreio ao vivo
shein export --format csv                 # para planilha
```

## 5. Pelo Claude

Com o servidor MCP registrado (o `setup` já fez isso), pergunte em português:

- "quanto gastei na Shein este ano?"
- "onde está meu último pedido?"
- "quanto eu já paguei de frete?"
- "já comprei esse conjunto antes? por quanto?"

## Manutenção

```sh
shein sync             # incremental: para no primeiro trecho sem novidade
shein sync --full      # varre tudo de novo
shein sync --reparse   # reprocessa o que está salvo, sem rede
shein doctor           # quando alguma coisa parar de funcionar
```
