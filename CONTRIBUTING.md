# Contribuindo

## Ambiente

Requer [Bun](https://bun.sh) ≥ 1.3.

```sh
bun install
bun run verify
```

`bun run verify` é o portão: type-check estrito, testes e as invariantes do
servidor MCP real sobre stdio. Se ele passa, o PR passa.

## Convenções

- **Código, comentários, testes e commits em inglês.** Documentação, descrições
  de tools, help do CLI e mensagens de erro em **pt-BR** — quem lê essas é o
  usuário.
- Sem linter. O gate é `tsc` estrito (`noUncheckedIndexedAccess`, `noUnused*`,
  `verbatimModuleSyntax`) mais os testes.
- Nenhum arquivo de lógica acima de ~450 linhas.
- Comentários explicam **por quê**, não o quê.
- Conventional Commits, sem escopo, uma linha, até 72 caracteres.

## Regras de arquitetura

Estas não são estilo, são o que mantém o projeto consertável quando a Shein
mudar (veja [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)):

1. Nenhuma rede fora de `src/core/http.ts`.
2. Só `src/domain/normalize.ts` conhece nomes de campo da Shein.
3. SDK do MCP só em `src/mcp/`; commander só em `src/cli/`; `playwright-core`
   só por import dinâmico.
4. Dinheiro em centavo inteiro para dentro; decimal só na borda da tool.
5. stdout é do JSON-RPC. Log só no stderr.
6. Falha de tool vira `isError`, nunca crash.
7. **Nada de escrita na conta.** Nem uma tool, nem um path no `raw_get`.

## Testes

Escreva o teste antes. Sem framework de mock: os colaboradores (fetch, relógio,
sessão, banco) são injetados — veja `test/helpers.ts`.

- Mudou um parser? Incremente `PARSER_VERSION` em `src/cache/sync.ts`.
- Mudou uma tool? Rode `bun run docs:tools`.
- Testes que precisam da conta real ficam em `test/integration/` e
  `test/local/`, e se auto-ignoram quando a sessão ou as capturas não existem.

## Publicando

A tag `vX.Y.Z` dispara o release: binários para Linux, macOS e Windows, e o
publish no npm por OIDC (trusted publishing, sem token).

Uma ressalva do npm: **a primeira versão de um pacote novo não sai por OIDC.**
O npmjs exige que o pacote exista para você configurar o trusted publisher, e
exige o trusted publisher para publicar ([npm/cli#8544](https://github.com/npm/cli/issues/8544)).
Então a `0.1.0` foi publicada à mão (`npm publish --access public --otp=…`) e o
trusted publisher foi configurado depois. O workflow pula a publicação quando a
versão já está no registro, em vez de falhar.

## Dado pessoal

O repositório é público. `test/fixtures.test.ts` falha se e-mail, CEP, CPF ou
nome real aparecer nos fixtures. As capturas cruas ficam em `task/`, que é
gitignored. Nunca commite uma captura sem passar por
`scripts/anonymize-fixture.ts`.
