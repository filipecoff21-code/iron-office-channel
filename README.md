# Iron Office — canal do Claude Code

Liga o dashboard do **Iron Office** (https://iron-office.vercel.app) à sessão do Claude Code na sua máquina:

- você escreve no **chat do site** (`/chat`) e o Iron responde ali mesmo;
- o **feed** e o **mapa 3D** do dashboard mostram as ferramentas e os agentes trabalhando enquanto ele responde.

O motor é o seu Claude Code (sua assinatura, seus arquivos). O site é só a janela.

## Instalar e ligar

1. Faça o onboarding do Iron Office até o **passo 2 (Ligar o Iron)** (gera a chave e salva em `~/.claude/iron-office-api-key`).
2. No terminal:

   ```bash
   npx iron-edge office
   ```

   Esse comando adiciona este marketplace, instala o plugin `iron-office` e abre o Claude Code com o canal ligado.
3. O Claude Code mostra um **aviso de tela cheia** (canais ainda são *research preview*). Aceite.
4. Abra https://iron-office.vercel.app/chat. Em até 1 minuto aparece **"Iron online"**.

**Deixe essa aba do terminal aberta.** É ela que faz o Iron responder no site.

## Instalação manual

```bash
claude plugin marketplace add filipecoff21-code/iron-office-channel
claude plugin install iron-office@iron-office-channel --scope user
IRON_OFFICE_CHANNEL=1 claude --dangerously-load-development-channels plugin:iron-office@iron-office-channel
```

Prefira `npx iron-edge office`, que faz isso tudo e confere cada passo.

## Como funciona

| Peça | O que faz |
|---|---|
| `dist/server.mjs` | Servidor MCP (canal). Puxa as mensagens do site (`GET /api/chat/pull`, a cada 2 s com o chat aberto, 15 s fechado), injeta na sessão, confirma a entrega (`POST /api/chat/ack`) e expõe as ferramentas `reply` (resposta no chat) e `deliver` (salva a entrega em `POST /api/deliverables`, com o cartão de ação opcional `card` que o chat mostra, e devolve o link `/deliverables?id=`). Marca presença a cada 30 s e, ao fechar (inclusive fechando a janela do terminal), avisa o site que o Iron saiu (o escritório anoitece). |
| ferramentas da loja | `shop_status` (a loja Shopify está conectada? `GET /api/shopify/graphql`) e `shop_query` (query ou mutation GraphQL da Admin API, `POST /api/shopify/graphql`; resposta acima de 60 kB vem cortada). Funcionam em **qualquer** sessão, não só no canal: é por elas que o agente `iron-shopify` fala com a loja, sem ler a chave nem fazer `curl` (desde a 0.3.4). |
| `hooks/post-event.mjs` | Hooks `PostToolUse`, `SubagentStart`, `SubagentStop` e `Stop` mandam a atividade pro `POST /api/events` (feed e mapa 3D). Só na sessão do canal (`IRON_OFFICE_CHANNEL=1`): `claude` aberto em outra pasta não manda nada. Ferramenta usada dentro de um subagente leva o id e o tipo do agente que a usou. |

- **Só a sessão aberta com o canal recebe o chat.** O plugin fica ligado em toda sessão do Claude Code (por causa dos hooks), mas uma aba comum não puxa mensagem nenhuma.
- **Entrega garantida:** a mensagem só vira "entregue" depois que a sessão recebeu. Se a internet cair no meio, ela volta pra fila em 60 s.
- **Mensagem velha não é executada:** o que ficou mais de 15 minutos esperando (terminal fechado) expira, e o chat avisa pra mandar de novo.
- Só **uma** sessão por máquina recebe as mensagens (lock em `~/.iron/office.lock`). As outras ficam passivas e assumem quando a ativa fecha.
- Sem chave: sobe em modo degradado e só explica como resolver.
- Chave inválida: avisa uma vez no terminal e tenta de novo depois de 5 minutos.
- Pra testar contra um servidor local: `IRON_OFFICE_URL=http://localhost:3000`.

## O que sai da sua máquina

Com a chave do Iron Office salva, **toda sessão** do Claude Code manda pro seu painel (visível só pra você):

- o nome de cada ferramenta usada (menos `Read`, `Grep` e `Glob`);
- o **caminho** dos arquivos criados ou editados (nunca o conteúdo);
- os primeiros 200 caracteres de cada comando de terminal e a descrição curta dele;
- buscas na web e o **domínio** dos endereços visitados (sem caminho nem parâmetros);
- o nome e a descrição curta dos agentes acionados;
- a pasta onde a sessão está rodando e o identificador da sessão;
- ao fechar, um aviso de que o Iron saiu (o escritório anoitece).

A **resposta** das ferramentas (saída de comando, conteúdo lido, resultado de agente) **nunca sai**.

O feed só aceita o hook desta versão em diante. Sessão do Claude aberta antes de atualizar o plugin não manda mais nada: feche e abra o canal de novo (`ironoffice`) pra voltar a ver a atividade.

Nos campos acima, padrões conhecidos de segredo são apagados **antes** de sair: chaves de Stripe, Shopify, Meta, GitHub, OpenAI/Anthropic, Supabase e AWS, JWT, `Bearer`, `ALGO_KEY=valor`, `"password": "…"`, `--password X`, `--token=X`, `-pSENHA` e `-u usuario:senha`. É uma lista de padrões, não uma garantia: um segredo num formato que ela não conhece passa.

**Pra desligar:** `claude plugin disable iron-office@iron-office-channel` (ou `uninstall`). Apagar `~/.claude/iron-office-api-key` também corta todo envio.

## Desenvolvimento

```bash
npm install
npm run build   # gera dist/server.mjs (commitado, sem dependência de runtime)
npm test        # build + testes sem rede (servidor falso, HOME temporário)
```

Requer Node 18+.
