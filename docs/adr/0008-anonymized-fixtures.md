# ADR-0008: Fixtures reais anonimizadas num repositório público

## Contexto

Status: aceito.

Testar parser de API instável com payload inventado prova
pouco. Mas o repositório é público e as capturas vêm de uma conta real, com
nome, endereço, CPF e código de rastreio.

## Decisão

As capturas cruas ficam em `task/captures/` (gitignored, 0600) e alimentam
`test/local/*.local.test.ts`, que se auto-ignora quando a pasta não existe.
`scripts/anonymize-fixture.ts` gera os fixtures públicos com mapeamento
determinístico (ids por hash salgado, mantendo prefixo e tamanho, trocados no
arquivo inteiro), placeholders para PII **por palavra-chave no nome do campo**,
e falha se qualquer valor original sobreviver.

Dinheiro, quantidade e data nunca são tocados. Ids são trocados por nome de
campo, nunca por "sequência longa de dígitos": um timestamp unix tem 10 dígitos
e um em milissegundos tem 13, como um código de rastreio.

## Consequências

Os testes rodam sobre shapes reais e as identidades financeiras continuam
verdadeiras nos fixtures. Em troca, uma captura nova exige uma passada de
anonimização antes de virar commit, e `test/fixtures.test.ts` é a guarda
permanente.
