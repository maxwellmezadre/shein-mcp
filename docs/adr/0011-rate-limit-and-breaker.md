# ADR-0011: Fila serial, backoff e breaker com cooldown persistido

## Contexto

Status: aceito.

Os projetos irmãos desta família levaram bloqueio anti-bot por
rajadas de requisições paralelas. Um agente que insiste depois da primeira
negativa é exatamente o que aprofunda o bloqueio.

## Decisão

Uma fila FIFO no cliente HTTP: nunca duas requisições em voo, mesmo com tool
calls concorrentes. Intervalo mínimo de 1 s mais jitter de até 0,5 s. Backoff
exponencial de 5 s a 5 min em rede, 429 e 5xx (4 tentativas). No veredito de
risco, o transporte cai para o navegador uma vez; no segundo, o breaker desarma
o cliente pelo resto do processo e grava um cooldown de 30 minutos em
`meta.antibot.cooldown_until`, respeitado por **qualquer processo novo**.

## Consequências

Vazão de ~0,7 requisição por segundo, e por isso o `sync` é em blocos com
cursor. Sair de um bloqueio exige ação humana (resolver a verificação no
navegador e refazer o login). Isso é deliberado: é a única saída que não piora a
situação.
