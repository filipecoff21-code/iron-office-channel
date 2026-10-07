// Iron Office — hook de telemetria.
// Lê o JSON do hook no stdin e manda pro POST /api/events do Iron Office (feed e mapa 3D).
// Regras: sem chave = sai em silêncio; timeout de 1,5 s; sai 0 SEMPRE (nunca bloqueia a sessão).
//
// O que sai da máquina é o MÍNIMO que o feed usa: nome da ferramenta, caminho do arquivo (nunca o
// conteúdo), começo do comando e a descrição dele, busca, domínio visitado, nome e descrição do
// agente, pasta de trabalho. A RESPOSTA das ferramentas nunca sai (nenhuma tela usa). Padrões
// conhecidos de chave, token e senha nesses campos são apagados antes do envio. Read/Grep/Glob
// não saem (ruído).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = (process.env.IRON_OFFICE_URL || "https://iron-office.vercel.app").replace(/\/+$/, "");
const NOISE = new Set(["Read", "Grep", "Glob"]);

function readKey() {
  try {
    const buf = readFileSync(join(homedir(), ".claude", "iron-office-api-key"));
    const utf16 = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
    return buf
      .toString(utf16 ? "utf16le" : "utf8")
      .replace(/[﻿\u0000]/g, "")
      .trim();
  } catch {
    return "";
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    setTimeout(() => resolve(data), 1500);
  });
}

// Padrões de segredo apagados de todo texto que sai
const SECRET_PATTERNS = [
  /iok_[A-Za-z0-9]+/g, // chave do próprio Iron Office
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]+/g, // Stripe
  /\bsbp_[A-Za-z0-9]+/g, // Supabase access token
  /\bshp(?:at|ca|pa|ss)_[A-Za-z0-9]+/g, // Shopify
  /\bEAA[A-Za-z0-9]{20,}/g, // Meta
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI / Anthropic
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, // JWT
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(?:aws_secret_access_key|aws_session_token)\b\s*[=:\s]\s*\S+/gi, // AWS secret (aws configure set …)
  /["']?\b[\w-]*(?:key|token|secret|password|passwd|pwd|pass)[\w-]*\b["']?\s*:\s*["'][^"']*["']/gi, // "campo": "valor" (JSON/YAML)
  /--?(?:password|passwd|pass|token|secret|api-?key|auth|access-token)(?:[=\s]+)\S+/gi, // --password X, --token=X
  /(\s-p)(?!\s)\S+/g, // mysql -pSENHA (grudado; `mkdir -p x` não casa)
  /(\s-u\s+)[^\s:]+:\S+/g, // curl -u usuario:senha
  /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD)[A-Z0-9_]*)\s*[=:]\s*\S+/gi,
  /:\/\/[^\s/:@]+:[^\s/@]+@/g, // usuário:senha em URL
];

function redact(s) {
  let out = s;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, g1) => {
      if (typeof g1 !== "string") return "[redigido]";
      if (/^\s-[pu]/.test(g1)) return `${g1}[redigido]`; // mantém a flag, apaga o valor
      if (/^(Bearer|Basic)$/i.test(g1)) return "[redigido]";
      return /=|:/.test(m) ? `${g1}=[redigido]` : "[redigido]";
    });
  }
  return out;
}

// corta por caractere (code point), sem partir emoji ao meio
function cut(v, max) {
  if (typeof v !== "string") return undefined;
  const chars = Array.from(redact(v));
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

// Campos que cada ferramenta pode mandar (o resto fica na máquina)
function pickInput(tool, input) {
  const i = input && typeof input === "object" ? input : {};
  switch (tool) {
    case "Bash":
      return { command: cut(i.command, 200), description: cut(i.description, 120) };
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { file_path: cut(i.file_path ?? i.notebook_path, 300) };
    case "Agent":
    case "Task":
      return { subagent_type: cut(i.subagent_type, 80), description: cut(i.description, 120) };
    case "WebSearch":
      return { query: cut(i.query, 200) };
    case "WebFetch": {
      // só o domínio: caminho e query podem carregar token (o feed mostra só o host mesmo)
      let host;
      try {
        host = new URL(String(i.url)).origin;
      } catch {
        host = undefined;
      }
      return { url: host };
    }
    default:
      return {};
  }
}

function strip(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

async function main() {
  const key = readKey();
  if (!key) return;
  let hook;
  try {
    hook = JSON.parse(await readStdin());
  } catch {
    return;
  }
  if (!hook || typeof hook !== "object") return;
  if (hook.tool_name && NOISE.has(hook.tool_name)) return;

  const event = hook.hook_event_name ?? null;
  const isAgentEvent = event === "SubagentStart" || event === "SubagentStop";
  // evento de agente sem tipo não diz quem trabalhou: não vale um item no feed
  if (isAgentEvent && !hook.agent_type) return;

  const toolName = hook.tool_name ?? event;
  if (!toolName) return;

  const toolInput = isAgentEvent
    ? strip({ agent_type: cut(hook.agent_type, 80), agent_id: cut(hook.agent_id, 80) })
    : strip(pickInput(toolName, hook.tool_input));

  const body = {
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: null, // a resposta das ferramentas nunca sai da máquina
    is_error: false,
    cwd: typeof hook.cwd === "string" ? hook.cwd : process.cwd(),
    session_id: typeof hook.session_id === "string" ? hook.session_id : null,
    hook_event_name: event,
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1500);
  try {
    await fetch(`${BASE}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    // silêncio: telemetria nunca atrapalha a sessão
  } finally {
    clearTimeout(t);
  }
}

main().finally(() => process.exit(0));
