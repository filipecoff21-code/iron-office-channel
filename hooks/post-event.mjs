// Iron Office — hook de telemetria.
// Lê o JSON do hook no stdin e manda pro POST /api/events do Iron Office (feed e mapa 3D).
// Regras: sem chave = sai em silêncio; timeout de 1,5 s; sai 0 SEMPRE (nunca bloqueia a sessão).
// Só a sessão do canal manda (env IRON_OFFICE_CHANNEL=1, que o `npx iron-edge office` injeta e o
// hook herda): o plugin fica ligado em toda sessão do Claude Code, e um `claude` aberto em outro
// projeto não pode encher a coluna "Atividade" nem mandar os caminhos dele pro banco.
//
// O que sai da máquina é o MÍNIMO que o feed usa: nome da ferramenta, caminho do arquivo (nunca o
// conteúdo), começo do comando e a descrição dele, busca, domínio visitado, nome e descrição do
// agente, pasta de trabalho. A RESPOSTA das ferramentas nunca sai (nenhuma tela usa). Padrões
// conhecidos de chave, token e senha nesses campos são apagados antes do envio. Read/Grep/Glob
// não saem (ruído). Com `office_feed: off` no ~/.iron/config.yaml (0.5.0), nada sai.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redact, feedOn } from "./shared.mjs";

const BASE = (process.env.IRON_OFFICE_URL || "https://ironoffice.app").replace(/\/+$/, "");
const NOISE = new Set(["Read", "Grep", "Glob"]);

// Versão do hook (0.3.8+): o site só grava evento que traz versão. Sessão aberta antes do update roda
// o hook velho, que não manda, e por isso some do feed sem precisar fechar a aba.
// 0.3.9: sem plugin.json legível, vai sem versão (undefined some do JSON) e o site responde 204:
// um hook que não sabe quem é não finge ser a versão atual.
function hookVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "..", ".claude-plugin", "plugin.json"), "utf8")).version || undefined;
  } catch {
    return undefined;
  }
}

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
  if (process.env.IRON_OFFICE_CHANNEL !== "1") return;
  if (!feedOn()) return; // 0.5.0: feed desligado (npx iron-edge office --sem-feed) não manda nada
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

  // ferramenta usada DENTRO de um subagente traz agent_id/agent_type no topo (medido no 2.1.301):
  // vai junto pra coluna atribuir a ação ao agente certo e ao pedido dele
  const toolInput = isAgentEvent
    ? strip({ agent_type: cut(hook.agent_type, 80), agent_id: cut(hook.agent_id, 80) })
    : strip({ ...pickInput(toolName, hook.tool_input), agent_id: cut(hook.agent_id, 40), agent_type: cut(hook.agent_type, 80) });

  const body = {
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: null, // a resposta das ferramentas nunca sai da máquina
    is_error: false,
    cwd: cut(typeof hook.cwd === "string" ? hook.cwd : process.cwd(), 300), // 0.5.0: a pasta também passa pelo filtro
    session_id: typeof hook.session_id === "string" ? hook.session_id : null,
    hook_event_name: event,
    hook_version: hookVersion(),
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
