// Iron Office — servidor de canal do Claude Code.
// Puxa as mensagens que o aluno escreveu no dashboard (iron-office.vercel.app/chat),
// injeta na sessão como notifications/claude/channel, e expõe a ferramenta `reply`
// pra resposta do Iron voltar pro site.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { join } from "node:path";

const VERSION = "0.2.1";
const BASE = (process.env.IRON_OFFICE_URL || "https://iron-office.vercel.app").replace(/\/+$/, "");
const KEY_PATH = join(homedir(), ".claude", "iron-office-api-key");
const LOCK_DIR = join(homedir(), ".iron");
const LOCK_PATH = join(LOCK_DIR, "office.lock");
const DEFAULT_CONVERSATION = "00000000-0000-0000-0000-000000000001";

const FAST_MS = 2_000;
const SLOW_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;
const AUTH_PAUSE_MS = 5 * 60_000;
const PRESENCE_MS = 30_000;
const RETAKE_MS = 15_000;

function log(msg) {
  process.stderr.write(`[iron-office] ${msg}\n`);
}

// A chave pode ter sido gravada pelo `echo` do Windows (UTF-16 com BOM) ou com quebra de linha:
// normaliza antes de usar, senão o servidor recebe lixo e responde 401 pra sempre.
function readKey() {
  try {
    const buf = readFileSync(KEY_PATH);
    const utf16 = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
    return buf
      .toString(utf16 ? "utf16le" : "utf8")
      .replace(/[﻿\u0000]/g, "")
      .trim();
  } catch {
    return "";
  }
}

const API_KEY = readKey();
const DEGRADED = !API_KEY;

// ─── Processos (detecção do canal e dono do lock) ───────────────────────
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout || ""));
    });
  });
}

async function processInfo(pid) {
  if (process.platform === "win32") {
    const out = await run("powershell", [
      "-NoProfile",
      "-Command",
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; "$($p.ParentProcessId)|$($p.CommandLine)"`,
    ]);
    const s = (out || "").trim();
    const i = s.indexOf("|");
    if (i < 0) return null;
    return { ppid: parseInt(s.slice(0, i), 10), cmd: s.slice(i + 1) };
  }
  const out = await run("ps", ["-o", "ppid=,command=", "-p", String(pid)]);
  const m = (out || "").trim().match(/^(\d+)\s+(.*)$/s);
  if (!m) return null;
  return { ppid: parseInt(m[1], 10), cmd: m[2] };
}

// ─── Esta sessão é o canal? ─────────────────────────────────────────────
// O plugin fica ligado em TODA sessão do Claude Code (hooks de telemetria), mas só a sessão
// aberta com o canal (`npx iron-edge office`) pode puxar mensagens: uma sessão comum puxaria a
// mensagem e o Claude ignoraria a notificação. O cliente não anuncia o canal no initialize
// (medido em 06/10/2026). Ordem: (1) env IRON_OFFICE_CHANNEL=1, que o `iron-edge office` injeta;
// (2) a linha de comando de um processo claude/node acima deste com a flag de canal seguida do
// id do plugin. Sem conseguir ler, fica OCIOSO (falha fechada): perder o chat é melhor que perder
// mensagem.
const CHANNEL_ID = "iron-office@iron-office-channel";
const CHANNEL_FLAGS = new Set(["--dangerously-load-development-channels", "--channels"]);

function isChannelCommand(cmd) {
  const tokens = cmd.split(/\s+/).filter(Boolean);
  const exe = (tokens[0] || "").split(/[\\/]/).pop().toLowerCase();
  if (!/^(claude|node)(\.exe|\.cmd)?$/.test(exe)) return false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const [flag, inline] = t.split("=", 2);
    if (!CHANNEL_FLAGS.has(flag)) continue;
    const value = inline ?? tokens[i + 1] ?? "";
    if (value.split(",").some((v) => v.endsWith(CHANNEL_ID))) return true;
  }
  return false;
}

async function detectChannelMode() {
  if (process.env.IRON_OFFICE_CHANNEL === "1") return true;
  let pid = process.ppid;
  for (let depth = 0; depth < 4 && pid > 1; depth++) {
    const info = await processInfo(pid);
    if (!info) return false;
    if (isChannelCommand(info.cmd)) return true;
    pid = info.ppid;
  }
  return false;
}

// ─── Lock: só UMA sessão por máquina faz o pull ─────────────────────────
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && e.code === "EPERM";
  }
}

// O pid do lock pode ter sido reaproveitado por outro programa: só conta como dono se o processo
// ainda for um servidor do iron-office. Sem conseguir ler, presume vivo (não rouba o lock).
async function holderAlive(pid) {
  if (!pid || pid === process.pid || !pidAlive(pid)) return false;
  const info = await processInfo(pid);
  return info ? info.cmd.includes("iron-office") : true;
}

async function acquireLock() {
  try {
    mkdirSync(LOCK_DIR, { recursive: true });
  } catch {
    // segue: writeFile acusa se não der
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" }); // atômico: falha se já existe
      return true;
    } catch (e) {
      if (!e || e.code !== "EEXIST") {
        log(`lock indisponível (${e?.message}); seguindo sem lock`);
        return true;
      }
    }
    const readHolder = () => {
      try {
        return parseInt(readFileSync(LOCK_PATH, "utf8").trim(), 10);
      } catch {
        return NaN;
      }
    };
    let holder = readHolder();
    if (Number.isNaN(holder)) {
      // o `wx` cria o arquivo vazio e só depois grava o pid: espera e relê antes de chamar de órfão
      await new Promise((r) => setTimeout(r, 200));
      holder = readHolder();
    }
    if (holder === process.pid) return true;
    if (await holderAlive(holder)) return false;
    try {
      unlinkSync(LOCK_PATH); // lock órfão
    } catch {
      // outro processo apagou antes: a próxima volta resolve
    }
  }
  return false;
}

function releaseLock() {
  try {
    if (readFileSync(LOCK_PATH, "utf8").trim() === String(process.pid)) unlinkSync(LOCK_PATH);
  } catch {
    // nada
  }
}

// ─── Estado ─────────────────────────────────────────────────────────────
// mode: "starting" | "degraded" | "idle" | "channel" (detectado, pegando o lock) | "passive" | "active"
let mode = DEGRADED ? "degraded" : "starting";
let initialized = false;
let started = false;
let stopped = false;

const state = {
  lastPullAt: null,
  lastPullError: null,
  dashboardOpen: false,
  authPausedUntil: 0,
};

// ids já injetados na sessão: se o ack falhar e o pull devolver de novo, só confirma, não repete
const injected = new Set();
function remember(id) {
  injected.add(id);
  if (injected.size > 500) injected.delete(injected.values().next().value);
}

function maskedKey() {
  if (!API_KEY) return "(nenhuma)";
  return `iok_…${API_KEY.slice(-4)}`;
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
      "Só a sessão aberta com `npx iron-edge office` recebe mensagens do site. Se nenhuma tag <channel> chegou, esta sessão provavelmente não é o canal: a ferramenta `status` confirma.",
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
        description: "Mostra o estado da conexão com o Iron Office (URL, chave mascarada, modo, último pull, dashboard aberto).",
        inputSchema: { type: "object", properties: {} },
      },
    ];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function text(t, isError = false) {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

const MODE_LABEL = {
  starting: "iniciando",
  channel: "canal detectado, conectando",
  degraded: "sem chave",
  idle: "fora do canal (esta sessão não recebe o chat; rode `npx iron-edge office`)",
  passive: "passivo (outra sessão desta máquina é a ativa)",
  active: "ativo",
};

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
        `Modo: ${MODE_LABEL[mode]}`,
        `Último pull: ${state.lastPullAt ?? "nenhum ainda"}${state.lastPullError ? ` (erro: ${state.lastPullError})` : ""}`,
        `Dashboard aberto: ${state.dashboardOpen ? "sim" : "não"}`,
        `Pasta: ${process.cwd()}`,
      ].join("\n"),
    );
  }

  if (name === "reply") {
    if (mode !== "active") {
      return text(`Esta sessão não responde o Iron Office (modo: ${MODE_LABEL[mode]}).`, true);
    }
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

// true só se a notificação foi escrita no transporte da sessão
async function notify(content, meta) {
  try {
    await mcp.notification({ method: "notifications/claude/channel", params: { content, meta } });
    return true;
  } catch (e) {
    log(`falhou ao entregar na sessão: ${e.message}`);
    return false;
  }
}

// ─── Loops ──────────────────────────────────────────────────────────────
let backoff = 0;
let authWarned = false;

// Entrega em 2 fases: o pull reivindica (claimed); só confirma (ack → delivered) o que de fato
// entrou na sessão. O que não for confirmado em 60 s o banco devolve pra fila.
async function pullOnce() {
  const data = await api("/api/chat/pull");
  state.lastPullAt = new Date().toISOString();
  state.lastPullError = null;
  state.dashboardOpen = data?.dashboard_open === true;

  const toAck = [];
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  for (const m of messages) {
    if (!m || typeof m.id !== "string") continue;
    if (injected.has(m.id)) {
      toAck.push(m.id);
      continue;
    }
    const content = typeof m.content === "string" ? m.content.trim() : "";
    if (!content) {
      log(`mensagem ${m.id} sem texto: descartada`);
      toAck.push(m.id);
      continue;
    }
    const ok = await notify(content, {
      chat_id: typeof m.conversation_id === "string" && m.conversation_id ? m.conversation_id : DEFAULT_CONVERSATION,
      message_id: m.id,
      user: "aluno",
      ts: typeof m.created_at === "string" && m.created_at ? m.created_at : new Date().toISOString(),
    });
    if (ok) {
      remember(m.id);
      toAck.push(m.id);
    }
  }
  if (toAck.length > 0) {
    try {
      await api("/api/chat/ack", { method: "POST", body: { ids: toAck } });
    } catch (e) {
      log(`confirmação falhou (o banco reentrega em 60 s): ${e.message}`);
    }
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

function becomeActive() {
  mode = "active";
  log(`ativo em ${BASE}`);
  presenceOnce();
  setInterval(() => {
    if (Date.now() >= state.authPausedUntil) presenceOnce();
  }, PRESENCE_MS).unref();
  pullLoop();
}

// Só começa depois do handshake (initialize) E da detecção: notificação antes do initialize
// o cliente descarta.
async function maybeStart() {
  if (started || !initialized || mode === "starting" || stopped) return;
  started = true;
  if (mode === "degraded") {
    log("sem chave em ~/.claude/iron-office-api-key: modo degradado");
    return;
  }
  if (mode === "idle") {
    log("sessão sem o canal: não puxa mensagens (só os hooks de telemetria rodam)");
    return;
  }
  if (await acquireLock()) {
    becomeActive();
    return;
  }
  mode = "passive";
  log("outra sessão já é a ativa: modo passivo (tenta assumir a cada 15 s)");
  const retake = setInterval(async () => {
    if (stopped) return clearInterval(retake);
    if (await acquireLock()) {
      clearInterval(retake);
      becomeActive();
    }
  }, RETAKE_MS);
  retake.unref();
}

// ─── Boot ───────────────────────────────────────────────────────────────
function shutdown() {
  stopped = true;
  releaseLock();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
process.on("exit", releaseLock);
process.stdin.on("end", shutdown);

mcp.oninitialized = () => {
  initialized = true;
  maybeStart();
};

await mcp.connect(new StdioServerTransport());

if (!DEGRADED) {
  detectChannelMode().then((isChannel) => {
    mode = isChannel ? "channel" : "idle";
    maybeStart();
  });
}
