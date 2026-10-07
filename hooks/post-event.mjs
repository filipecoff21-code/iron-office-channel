// Iron Office — hook de telemetria.
// Lê o JSON do hook no stdin e manda pro POST /api/events do Iron Office.
// Regras: sem chave = sai em silêncio; timeout de 2 s; sai 0 SEMPRE (nunca bloqueia a sessão).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = (process.env.IRON_OFFICE_URL || "https://iron-office.vercel.app").replace(/\/+$/, "");
const NOISE = new Set(["Read", "Grep", "Glob"]);

function readKey() {
  try {
    return readFileSync(join(homedir(), ".claude", "iron-office-api-key"), "utf8").trim();
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

function short(v) {
  if (v == null) return null;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 500 ? s.slice(0, 500) : s;
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
  if (hook.tool_name && NOISE.has(hook.tool_name)) return;

  const isAgentEvent = hook.hook_event_name === "SubagentStart" || hook.hook_event_name === "SubagentStop";
  const body = {
    tool_name: hook.tool_name ?? hook.hook_event_name,
    tool_input: hook.tool_input ?? (isAgentEvent ? { agent_type: hook.agent_type, agent_id: hook.agent_id } : {}),
    tool_response: short(hook.tool_response ?? hook.last_assistant_message),
    is_error: false,
    cwd: hook.cwd ?? process.cwd(),
    session_id: hook.session_id ?? null,
    hook_event_name: hook.hook_event_name ?? null,
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2000);
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
