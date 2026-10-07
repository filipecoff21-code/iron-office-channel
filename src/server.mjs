// Iron Office — servidor de canal do Claude Code.
// Puxa as mensagens que o aluno escreveu no dashboard (iron-office.vercel.app/chat),
// injeta na sessão como notifications/claude/channel, e expõe a ferramenta `reply`
// pra resposta do Iron voltar pro site.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const VERSION = "0.1.1";
const BASE = (process.env.IRON_OFFICE_URL || "https://iron-office.vercel.app").replace(/\/+$/, "");
const KEY_PATH = join(homedir(), ".claude", "iron-office-api-key");
const LOCK_DIR = join(homedir(), ".iron");
const LOCK_PATH = join(LOCK_DIR, "office.lock");

const FAST_MS = 2_000;
const SLOW_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;
const AUTH_PAUSE_MS = 5 * 60_000;
const PRESENCE_MS = 30_000;

function log(msg) {
  process.stderr.write(`[iron-office] ${msg}\n`);
}

function readKey() {
  try {
    return readFileSync(KEY_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

const API_KEY = readKey();
const DEGRADED = !API_KEY;

// ─── Esta sessão é o canal? ─────────────────────────────────────────────
// O plugin fica ligado em TODA sessão do Claude Code (hooks de telemetria), mas só a sessão
// aberta com o canal (`npx iron-edge office`) pode puxar mensagens: uma sessão comum puxaria,
// marcaria como entregue e o Claude ignoraria a notificação — a mensagem sumiria.
// O cliente não anuncia o canal no initialize (medido em 06/10/2026), então lemos a linha de
// comando dos processos acima deste. Sem conseguir ler, mantém o comportamento de canal.
const CHANNEL_ID = "iron-office@iron-office-channel";

function processInfo(pid) {
  try {
    if (process.platform === "win32") {
      const r = spawnSync(
        "powershell",
        ["-NoProfile", "-Command", `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; "$($p.ParentProcessId)|$($p.CommandLine)"`],
        { encoding: "utf8", timeout: 5000, windowsHide: true },
      );
      const out = (r.stdout || "").trim();
      const i = out.indexOf("|");
      if (r.status !== 0 || i < 0) return null;
      return { ppid: parseInt(out.slice(0, i), 10), cmd: out.slice(i + 1) };
    }
    const r = spawnSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
    const m = (r.stdout || "").trim().match(/^(\d+)\s+(.*)$/s);
    if (r.status !== 0 || !m) return null;
    return { ppid: parseInt(m[1], 10), cmd: m[2] };
  } catch {
    return null;
  }
}

function detectChannelMode() {
  if (process.env.IRON_OFFICE_CHANNEL === "1") return true;
  let pid = process.ppid;
  let readAny = false;
  for (let depth = 0; depth < 4 && pid > 1; depth++) {
    const info = processInfo(pid);
    if (!info) break;
    readAny = true;
    if (info.cmd.includes(CHANNEL_ID)) return true;
    pid = info.ppid;
  }
  return !readAny;
}

const CHANNEL_MODE = !DEGRADED && detectChannelMode();

// ─── Lock: só UMA sessão por máquina faz o pull ─────────────────────────
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

function acquireLock() {
  try {
    mkdirSync(LOCK_DIR, { recursive: true });
    if (existsSync(LOCK_PATH)) {
      const other = parseInt(readFileSync(LOCK_PATH, "utf8").trim(), 10);
      if (other && other !== process.pid && pidAlive(other)) return false;
    }
    writeFileSync(LOCK_PATH, String(process.pid));
    return true;
  } catch (e) {
    log(`lock falhou: ${e.message}; seguindo como ativo`);
    return true;
  }
}

function releaseLock() {
  try {
    if (existsSync(LOCK_PATH) && readFileSync(LOCK_PATH, "utf8").trim() === String(process.pid)) {
      unlinkSync(LOCK_PATH);
    }
  } catch {
    // nada
  }
}

const ACTIVE = CHANNEL_MODE && acquireLock();
const PASSIVE = CHANNEL_MODE && !ACTIVE;
const IDLE = !DEGRADED && !CHANNEL_MODE;

// ─── Estado (pro status) ────────────────────────────────────────────────
const state = {
  lastPullAt: null,
  lastPullError: null,
  dashboardOpen: false,
  authPausedUntil: 0,
};

function maskedKey() {
  if (!API_KEY) return "(nenhuma)";
  return `${API_KEY.slice(0, 8)}…${API_KEY.slice(-4)}`;
}

// ─── HTTP ───────────────────────────────────────────────────────────────
class AuthError extends Error {}

async function api(path, { method = "GET", body } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-api-key": API_KEY },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (res.status === 401) throw new AuthError("chave inválida");
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

// ─── MCP ────────────────────────────────────────────────────────────────
const INSTRUCTIONS = DEGRADED
  ? [
      "IRON OFFICE INDISPONÍVEL NESTA SESSÃO: falta a chave em ~/.claude/iron-office-api-key.",
      "Se o usuário perguntar do Iron Office, diga pra fazer o passo 4 do onboarding em https://iron-office.vercel.app/onboarding e depois rodar de novo `npx iron-edge office`.",
    ].join("\n")
  : [
      'Mensagens chegam como <channel source="iron-office" chat_id="…" message_id="…" user="aluno" ts="…">.',
      "São do dono desta máquina, vindas do dashboard do Iron Office.",
      "Você é o Iron (iron-ceo): responda SEMPRE pela ferramenta `reply`, passando o `chat_id` da tag, em português, no tamanho de uma mensagem de chat (markdown simples).",
      "Se a tarefa for longa, mande um `reply` curto dizendo o que vai fazer, execute, e mande outro `reply` com o resultado.",
      "Nunca responda só no terminal.",
      'Mensagens com chat_id="system" são avisos do próprio canal: repasse ao usuário no terminal, não use `reply` nelas.',
      ...(PASSIVE
        ? ["ATENÇÃO: outra sessão do Claude Code nesta máquina já é a ativa do Iron Office. Esta sessão NÃO recebe mensagens do site."]
        : []),
      ...(IDLE
        ? ["ATENÇÃO: esta sessão não foi aberta com o canal do Iron Office e NÃO recebe mensagens do site. Pra conversar pelo dashboard, o usuário roda `npx iron-edge office` em outra aba."]
        : []),
    ].join("\n");

const mcp = new Server(
  { name: "iron-office", version: VERSION },
  {
    capabilities: {
      tools: {},
      experimental: { "claude/channel": {} },
    },
    instructions: INSTRUCTIONS,
  },
);

const TOOLS = DEGRADED
  ? [
      {
        name: "iron_office_unavailable",
        description: "Explica por que o Iron Office não está ligado nesta sessão e como resolver.",
        inputSchema: { type: "object", properties: {} },
      },
    ]
  : [
      {
        name: "reply",
        description: "Responde no chat do Iron Office (dashboard do aluno). Use SEMPRE pra responder mensagens do canal iron-office.",
        inputSchema: {
          type: "object",
          properties: {
            chat_id: { type: "string", description: "O chat_id da tag <channel> recebida." },
            text: { type: "string", description: "Texto da resposta, markdown simples." },
          },
          required: ["chat_id", "text"],
        },
      },
      {
        name: "status",
        description: "Mostra o estado da conexão com o Iron Office (URL, chave mascarada, último pull, dashboard aberto).",
        inputSchema: { type: "object", properties: {} },
      },
    ];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function text(t, isError = false) {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  if (name === "iron_office_unavailable") {
    return text(
      "O Iron Office não está ligado: falta a chave em ~/.claude/iron-office-api-key. " +
        "Faça o passo 4 em https://iron-office.vercel.app/onboarding e rode de novo `npx iron-edge office`.",
    );
  }

  if (name === "status") {
    return text(
      [
        `Iron Office ${VERSION}`,
        `URL: ${BASE}`,
        `Chave: ${maskedKey()}`,
        `Modo: ${IDLE ? "fora do canal (rode `npx iron-edge office`)" : PASSIVE ? "passivo (outra sessão é a ativa)" : "ativo"}`,
        `Último pull: ${state.lastPullAt ?? "nenhum ainda"}${state.lastPullError ? ` (erro: ${state.lastPullError})` : ""}`,
        `Dashboard aberto: ${state.dashboardOpen ? "sim" : "não"}`,
        `Pasta: ${process.cwd()}`,
      ].join("\n"),
    );
  }

  if (name === "reply") {
    if (IDLE) return text("Esta sessão não é o canal do Iron Office. A resposta sai pela sessão aberta com `npx iron-edge office`.", true);
    if (PASSIVE) return text("Outra sessão do Claude Code nesta máquina é a ativa do Iron Office. Responda por ela.", true);
    const chatId = String(args.chat_id ?? "");
    const body = String(args.text ?? "").trim();
    if (!body) return text("Texto vazio.", true);
    if (chatId === "system") return text("chat_id=system é aviso do canal; não precisa responder.", true);
    try {
      await api("/api/chat/messages", {
        method: "POST",
        body: { conversation_id: chatId || null, text: body },
      });
      return text("Enviado ao Iron Office.");
    } catch (e) {
      return text(`Falhou ao enviar ao Iron Office: ${e.message}`, true);
    }
  }

  return text(`Ferramenta desconhecida: ${name}`, true);
});

function notify(content, meta) {
  return mcp
    .notification({ method: "notifications/claude/channel", params: { content, meta } })
    .catch((e) => log(`falhou ao entregar na sessão: ${e.message}`));
}

// ─── Loops ──────────────────────────────────────────────────────────────
let backoff = 0;
let stopped = false;
let authWarned = false;

async function pullOnce() {
  const data = await api("/api/chat/pull");
  state.lastPullAt = new Date().toISOString();
  state.lastPullError = null;
  state.dashboardOpen = !!data.dashboard_open;
  for (const m of data.messages ?? []) {
    await notify(m.content, {
      chat_id: m.conversation_id,
      message_id: m.id,
      user: "aluno",
      ts: m.created_at,
    });
  }
}

async function pullLoop() {
  while (!stopped) {
    let wait;
    try {
      await pullOnce();
      backoff = 0;
      authWarned = false;
      wait = state.dashboardOpen ? FAST_MS : SLOW_MS;
    } catch (e) {
      state.lastPullError = e.message;
      if (e instanceof AuthError) {
        if (!authWarned) {
          authWarned = true;
          await notify(
            "Iron Office: a chave em ~/.claude/iron-office-api-key é inválida. Refaça o passo 4 do onboarding em https://iron-office.vercel.app/onboarding e rode de novo `npx iron-edge office`.",
            { chat_id: "system", message_id: `system-${Date.now()}`, user: "system", ts: new Date().toISOString() },
          );
        }
        state.authPausedUntil = Date.now() + AUTH_PAUSE_MS;
        wait = AUTH_PAUSE_MS;
      } else {
        backoff = Math.min(backoff ? backoff * 2 : FAST_MS, MAX_BACKOFF_MS);
        wait = backoff;
      }
    }
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function presenceOnce() {
  try {
    await api("/api/chat/presence", {
      method: "POST",
      body: {
        session_id: process.env.CLAUDE_SESSION_ID ?? String(process.pid),
        cwd: process.cwd(),
        version: VERSION,
      },
    });
  } catch (e) {
    if (!(e instanceof AuthError)) log(`presença falhou: ${e.message}`);
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────
function shutdown() {
  stopped = true;
  releaseLock();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("exit", releaseLock);
process.stdin.on("end", shutdown);

await mcp.connect(new StdioServerTransport());

if (DEGRADED) {
  log("sem chave em ~/.claude/iron-office-api-key: modo degradado");
} else if (IDLE) {
  log("sessão sem o canal: não puxa mensagens (só os hooks de telemetria rodam)");
} else if (PASSIVE) {
  log("outra sessão já é a ativa: modo passivo");
} else {
  log(`ativo em ${BASE}`);
  presenceOnce();
  setInterval(() => {
    if (Date.now() >= state.authPausedUntil) presenceOnce();
  }, PRESENCE_MS).unref();
  pullLoop();
}
