# Iron Office — canal do Claude Code

Liga o dashboard do **Iron Office** (https://iron-office.vercel.app) à sessão do Claude Code na sua máquina:

- você escreve no **chat do site** (`/chat`) e o Iron responde ali mesmo;
- o **feed** e o **mapa 3D** do dashboard mostram as ferramentas e os agentes trabalhando enquanto ele responde.

O motor é o seu Claude Code (sua assinatura, seus arquivos). O site é só a janela.

## Instalar e ligar

1. Faça o onboarding do Iron Office até o **passo 4** (gera a chave e salva em `~/.claude/iron-office-api-key`).
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
claude --dangerously-load-development-channels plugin:iron-office@iron-office-channel
```

## Como funciona

| Peça | O que faz |
|---|---|
| `dist/server.mjs` | Servidor MCP (canal). Puxa as mensagens do site (`GET /api/chat/pull`, a cada 2 s com o chat aberto, 15 s fechado), injeta na sessão e expõe a ferramenta `reply`. Marca presença a cada 30 s. |
| `hooks/post-event.mjs` | Hooks `PostToolUse`, `SubagentStart`, `SubagentStop` e `Stop` mandam a atividade pro `POST /api/events` (feed e mapa 3D). `Read`/`Grep`/`Glob` ficam de fora. Sem chave, não manda nada. |

- Só **uma** sessão por máquina recebe as mensagens (lock em `~/.iron/office.lock`). As outras sobem em modo passivo.
- Sem chave: sobe em modo degradado e só explica como resolver.
- Chave inválida: avisa uma vez no terminal e tenta de novo depois de 5 minutos.
- Pra testar contra um servidor local: `IRON_OFFICE_URL=http://localhost:3000`.

## Desenvolvimento

```bash
npm install
npm run build   # gera dist/server.mjs (commitado, sem dependência de runtime)
```

Requer Node 18+.
