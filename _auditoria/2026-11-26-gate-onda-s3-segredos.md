# GATE — onda S3 (arquivos de segredo: chave trancada, .env com clique) — 2026-11-26 — Rodada 1 — faixa VAI SAIR
sha256: (rodada 1 auditou a árvore de trabalho sem commit; o hash final sai na rodada que liberar)
fonte: plano `Projetos/iron-edge/2026-11-26 - plano Iron Office onda S3 (...).md` · plugin base 0.35.0 (main 0e15d25) · instalador base tag v2.44.0 (25fdf20), branch onda-s3 e5d4a87
Preflight: plugin `npm test` 615/615 ok · instalador lint ok + 9 baterias verdes (test-office 167/167) · varredura de segredo nos arquivos alterados: nada fora dos testes · M1 medido (claude -p em bypassPermissions: deny Read barra Read e `cat`, só o arquivo listado) · G3 4/4 mutantes vermelhos e desfeitos
Painel: adversarial ✗ (5,5) · usuário-zero ✗ (6,0, sem bloqueador) · convenção ✓ com ressalvas (7,5) · aluno-zero ✓ com ressalvas (7,5) — VEREDITO: REPROVADO (2 bloqueadores)

| Sev | Lente | Achado | Evidência | Correção |
|-----|-------|--------|-----------|----------|
| BLOQUEADOR | adversarial | B1: liberação de `proj/.env` valia pra `cd outra && cat .env` (o cwd do evento ignora o cd do comando) | decide com liberação só de `<home>/proj/.env`: `cd /tmp/x && cat .env`, `cd ~ && cat .env` passaram | comando com cd/pushd/Set-Location/-C/--prefix e `.env` relativo → barra pedindo o caminho completo (MOTIVO_ENV_CD) |
| BLOQUEADOR | adversarial | B2: `cd ~/.claude && cat .credentials.json` passava | decide devolveu null | `.credentials.json` por presença em qualquer comando, como a chave |
| IMPORTANTE | adversarial, usuário-zero, convenção, aluno-zero | Grep com `path` de pasta (`~/.claude`, home, `/`) ou com `glob` escapava; Grep em `~/.iron/porteiro` lia o registro | sondas das 4 lentes | Grep na pasta que contém ou é `~/.claude` → MOTIVO_BUSCA; glob com `.env` pede, com nome da chave barra; tocaPorteiro lê `path` e `glob` |
| IMPORTANTE | usuário-zero | Depois do Não, o gancho mandava perguntar de novo e o servidor mandava não perguntar | `.env` sem liberação sempre devolvia a instrução do ask | Não grava `tipo: env-nao` 30 min; o gancho responde "siga sem" |
| IMPORTANTE | usuário-zero, adversarial | `.env.local.example` e afins pediam | Read barrado | modelo = termina em .example/.sample/.template |
| IMPORTANTE | adversarial | macOS: caminho com outra caixa da home travava a pergunta (abreviava pra ~ e o hash era do original) | envAskCheck "não é o do id" | abreviar a home só com a caixa exata |
| IMPORTANTE | adversarial | instalador: `.bak` do settings.json sobrescrito na mesma execução (dropiDeny e depois chaveDeny) | `.bak` guardava o arquivo já mexido | `travasDeny` grava as duas numa escrita só |
| IMPORTANTE | convenção, aluno-zero, adversarial | versão e README não atualizados; divergência da linha das instruções não registrada; uninstall não registrado | package.json 0.35.0 | 0.36.0 em package/plugin/marketplace/VERSION, linha no README do plugin, parágrafo no README do instalador (trava vale em todas as sessões, desinstalar não tira), comentário em server.mjs |
| IMPORTANTE | aluno-zero | a pergunta leva nome e pasta do `.env` pro chat do site; README dizia que nada sai | README:117 | documentado no README (texto da pergunta é decisão do plano) |
| IMPORTANTE (aceito, pendência) | usuário-zero, convenção | qualquer palavra `.env` num comando pede (`echo .env >> .gitignore`, `git log -- .env`), e qualquer comando que cite `iron-office-api-key` barra (`git commit -m`) | sondas | não corrigido: o plano pede presença; afinar por verbo de leitura é desenho novo. Vai pro relatório como pendência |
| IMPORTANTE (pré-existente) | adversarial | clique velho na fila vira liberação quando o plugin reabre (`until` pelo relógio do plugin) | porteiroResposta | já existia no porteiro de instalação; pendência fora da onda |
| POLIMENTO | adversarial | âncora do caminho cortado lê só as últimas 300 linhas do registro; envMeio quadrático com milhares de segmentos | — | registrado |
| POLIMENTO | usuário-zero | "Foi você que pediu…?" × botão "Sim, pode abrir" | — | texto é do plano (decisão do Filipe); vai pro gate do Filipe (E.11) |

PRÓXIMA AÇÃO: reauditar adversarial e usuário-zero (rodada 2) com a lente ⭐ abaixo.

# Rodada 2

lente ⭐: (1) Uma correção desfaz outra? B1 (comando com cd e `.env` curto passa a exigir caminho completo) contra a conveniência do usuário-zero (menos perguntas): venceu a segurança, porque a liberação é "só aquele caminho" (decisão P3); sacrificado: `cd proj && cp .env.example .env` agora pede o caminho completo. O "Não gravado" (env-nao) não desfaz o "Sim": a mesma decisão pro mesmo arquivo substitui a anterior em gravaLiberacao, e a instalação ignora qualquer tipo que comece com env. A regra `-c` do B1 também pega `bash -c "cat .env"` (minúsculas): aceito, o Iron refaz com caminho completo. (2) Rede estreitada: a regra dos modelos ficou mais larga do lado do "passa" (`.env.<x>.example` passa); o que ela segurava por acidente: um `.env.production.example` com senha de verdade dentro, que agora abre sem pergunta (aceito: o nome declara modelo). O `pastaVisivel` deixou de abreviar com caixa diferente: o caso vai pro caminho completo na pergunta, sem perda de trava. Nenhuma outra rede foi estreitada: B2 e Grep só alargam o que barra.

lente ⭐ — resposta de cada auditor:
- adversarial: CONCORDA. Cada troca descrita bate com o medido (cd + cp .env.example .env barra; env-nao substitui o Sim e não toca na instalação; a regra .env.<x>.example só alarga o "passa"); nenhuma rede estreitada esquecida.
- usuário-zero: CONCORDA. O Não vence por 30 min e o Sim só libera sem Não gravado; os tradeoffs (B1, -c, .env.production.example) estão declarados.

Painel r2: adversarial ✓ (7,5) · usuário-zero ✓ (8,0) — VEREDITO: LIBERADO · 0 bloqueador
B1 e B2 resolvidos (adversarial testou cd ../x, subshell, pushd, Set-Location, sl, chdir, git -C, --prefix, CD maiúsculo, builtin cd, tab, quebra de linha; B2 com $HOME, aspas, pushd).

| Sev | Lente | Achado | Evidência | Correção |
|-----|-------|--------|-----------|----------|
| IMPORTANTE (corrigido depois do LIBERADO, bom e barato) | adversarial | variantes de B1: Push-Location, env --chdir, git --work-tree, `cd;`/`cd&&` colados, cd"x" | decide passava com só proj/.env liberado | regex de mudar de pasta ampliada + teste "S3 r2" |
| IMPORTANTE (corrigido depois do LIBERADO) | adversarial | Grep com glob `.env`/`**/.env` sem pasta fixa aproveitava a liberação de proj/.env pra qualquer subpasta | PASSA com liberação | glob sem pasta fixa → pede caminho completo; teste "S3 r2" |
| POLIMENTO | adversarial | `-c` (grep -c, head -c) conta como mudar de pasta; `proj/.claude.json` barra | — | lado seguro, registrado |
| POLIMENTO | usuário-zero | MOTIVO_ENV_RECUSADO sem o nome do arquivo | — | registrado |
| incidente | usuário-zero | o auditor gravou na ~/.iron/porteiro/liberados.json real e deixou [] | relato do auditor | conferido pelo executor: só havia a liberação de teste de ~/teste-s3/.env e uma de instalação vencida; nada perdido |

Bateria depois das correções r2: plugin 625/625 ok · instalador lint + 9 baterias verdes.
PRÓXIMA AÇÃO: LIBERADO. Publicar só depois do gate do Filipe sobre o tom (G4/E.11).
