// Testes do plugin iron-office, sem rede externa: sobe um servidor HTTP falso que imita o
// Iron Office, roda o dist/server.mjs e o hooks/post-event.mjs contra ele com HOME temporário.
// Cobre os achados do gate de 06/10/2026: entrega em 2 fases (ack), nada antes do handshake,
// sessão comum não puxa, lock atômico com reassunção, e o hook não vaza segredo.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "server.mjs");
const HOOK = join(ROOT, "hooks", "post-event.mjs");
const KEY = "iok_" + "a".repeat(48);
const lixo = [];
let falhas = 0;
let total = 0;

function check(nome, ok, detalhe) {
  total++;
  if (ok) return console.log(`  ok  ${nome}`);
  falhas++;
  console.log(`  FALHOU  ${nome}${detalhe ? `\n          ${detalhe}` : ""}`);
}

function casa(key = KEY) {
  const home = mkdtempSync(join(tmpdir(), "iron-office-test-"));
  lixo.push(home);
  mkdirSync(join(home, ".claude"), { recursive: true });
  if (key !== null) writeFileSync(join(home, ".claude", "iron-office-api-key"), key);
  return home;
}

// servidor falso: guarda tudo que chega; `routes` decide a resposta
function fakeOffice(routes) {
  const calls = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const call = { method: req.method, path: req.url, key: req.headers["x-api-key"], body: body ? JSON.parse(body) : null };
      calls.push(call);
      const r = routes(call, calls) ?? { status: 200, json: {} };
      if (r.hang) return; // nunca responde
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json ?? {}));
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, calls, url: `http://127.0.0.1:${srv.address().port}` })));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// sobe o servidor MCP; devolve o processo, as linhas que ele escreveu e um send()
function startServer(home, url, env = {}) {
  const p = spawn(process.execPath, [SERVER], {
    env: { ...process.env, HOME: home, USERPROFILE: home, IRON_OFFICE_URL: url, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out = [];
  let buf = "";
  p.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        out.push({ at: Date.now(), msg: JSON.parse(line) });
      } catch {
        // não-JSON
      }
    }
  });
  let err = "";
  p.stderr.on("data", (c) => (err += c));
  const send = (msg) => p.stdin.write(JSON.stringify(msg) + "\n");
  const handshake = () => {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  };
  return { p, out, send, handshake, stderr: () => err };
}

const notifs = (out) => out.filter((o) => o.msg.method === "notifications/claude/channel");

async function runHook(home, url, input) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [HOOK], {
      env: { ...process.env, HOME: home, USERPROFILE: home, IRON_OFFICE_URL: url },
      stdio: ["pipe", "ignore", "ignore"],
    });
    p.on("exit", (code) => resolve(code));
    p.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

// ─── 1. entrega em 2 fases ──────────────────────────────────────────────
{
  console.log("entrega (ack)");
  let served = false;
  const f = await fakeOffice((c) => {
    if (c.path === "/api/chat/pull" && !served) {
      served = true;
      return { json: { dashboard_open: true, messages: [{ id: "m1", conversation_id: "c1", content: "oi", meta: {}, created_at: "2026-10-06T00:00:00Z" }] } };
    }
    if (c.path === "/api/chat/pull") return { json: { dashboard_open: true, messages: [] } };
  });
  const s = startServer(casa(), f.url, { IRON_OFFICE_CHANNEL: "1" });
  s.handshake();
  await sleep(2500);
  const n = notifs(s.out);
  const ack = f.calls.find((c) => c.path === "/api/chat/ack");
  check("mensagem injetada na sessão", n.length === 1 && n[0].msg.params.content === "oi");
  check("confirma (ack) o id depois de injetar", !!ack && JSON.stringify(ack.body.ids) === '["m1"]', JSON.stringify(ack));
  s.p.kill();
  f.srv.close();
}

// ─── 2. nada antes do handshake ─────────────────────────────────────────
{
  console.log("handshake");
  const f = await fakeOffice((c) => {
    if (c.path === "/api/chat/pull") return { json: { dashboard_open: true, messages: [{ id: "m2", conversation_id: "c1", content: "cedo", created_at: "x" }] } };
  });
  const s = startServer(casa(), f.url, { IRON_OFFICE_CHANNEL: "1" });
  await sleep(1500);
  check("não puxa antes do initialize", f.calls.filter((c) => c.path === "/api/chat/pull").length === 0);
  s.handshake();
  await sleep(1500);
  const initAt = s.out.find((o) => o.msg.id === 1)?.at ?? Infinity;
  const first = notifs(s.out)[0];
  check("primeira notificação sai depois da resposta do initialize", !!first && first.at >= initAt);
  s.p.kill();
  f.srv.close();
}

// ─── 3. pull perdido não perde mensagem ─────────────────────────────────
{
  console.log("resposta perdida");
  let n = 0;
  const f = await fakeOffice((c) => {
    if (c.path !== "/api/chat/pull") return;
    n++;
    if (n === 1) return { hang: true }; // 1ª resposta nunca chega
    return { json: { dashboard_open: true, messages: [] } };
  });
  const s = startServer(casa(), f.url, { IRON_OFFICE_CHANNEL: "1" });
  s.handshake();
  await sleep(1500);
  const acks = f.calls.filter((c) => c.path === "/api/chat/ack");
  check("sem resposta do pull, não confirma nada (o banco reentrega)", acks.length === 0);
  s.p.kill();
  f.srv.close();
}

// ─── 4. conteúdo nulo / campo ausente / vazio ───────────────────────────
{
  console.log("amostras");
  const cases = [
    ["nulo", { dashboard_open: null, messages: [{ id: "n1", conversation_id: null, content: null, meta: null, created_at: null }] }],
    ["campo ausente", { dashboard_open: true }],
    ["vazio", { dashboard_open: false, messages: [] }],
  ];
  for (const [nome, payload] of cases) {
    let served = false;
    const f = await fakeOffice((c) => {
      if (c.path === "/api/chat/pull" && !served) {
        served = true;
        return { json: payload };
      }
      if (c.path === "/api/chat/pull") return { json: { messages: [] } };
    });
    const s = startServer(casa(), f.url, { IRON_OFFICE_CHANNEL: "1" });
    s.handshake();
    await sleep(1200);
    const bad = notifs(s.out).filter((o) => typeof o.msg.params.content !== "string" || !o.msg.params.content);
    check(`${nome}: nenhuma notificação sem texto`, bad.length === 0);
    check(`${nome}: processo segue vivo`, s.p.exitCode === null);
    if (nome === "nulo") {
      const ack = f.calls.find((c) => c.path === "/api/chat/ack");
      check("nulo: mensagem sem texto é confirmada e descartada (não volta pra fila)", !!ack && ack.body.ids.includes("n1"));
    }
    s.p.kill();
    f.srv.close();
  }
}

// ─── 5. sessão comum não puxa ───────────────────────────────────────────
{
  console.log("modo canal");
  const f = await fakeOffice(() => ({ json: { messages: [] } }));
  const s = startServer(casa(), f.url, { IRON_OFFICE_CHANNEL: "" });
  s.handshake();
  await sleep(2500);
  check("sem a flag de canal no processo pai, não puxa", f.calls.length === 0, JSON.stringify(f.calls.map((c) => c.path)));
  s.p.kill();
  f.srv.close();
}

// ─── 6. lock: dois ao mesmo tempo e reassunção ──────────────────────────
{
  console.log("lock");
  const home = casa();
  const f = await fakeOffice((c) => (c.path === "/api/chat/pull" ? { json: { dashboard_open: true, messages: [] } } : {}));
  const a = startServer(home, f.url, { IRON_OFFICE_CHANNEL: "1" });
  const b = startServer(home, f.url, { IRON_OFFICE_CHANNEL: "1" });
  a.handshake();
  b.handshake();
  await sleep(2000);
  const ativos = [a, b].filter((x) => /ativo em/.test(x.stderr())).length;
  check("dois servidores juntos: só um fica ativo", ativos === 1, `a: ${a.stderr().trim()} | b: ${b.stderr().trim()}`);
  const [ativo, passivo] = /ativo em/.test(a.stderr()) ? [a, b] : [b, a];
  ativo.p.kill("SIGTERM");
  await sleep(17000);
  check("o passivo assume quando o ativo sai", /ativo em/.test(passivo.stderr()), passivo.stderr().trim());
  passivo.p.kill();
  f.srv.close();
}

// ─── 7. hook não vaza segredo ───────────────────────────────────────────
{
  console.log("hook");
  const f = await fakeOffice(() => ({ json: {} }));
  const home = casa();
  const big = "STRIPE_SECRET=sk_live_ABC123XYZ\n" + "x".repeat(200_000);
  await runHook(home, f.url, { session_id: "s", cwd: "/tmp", hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/app/.env", content: big }, tool_response: big });
  await runHook(home, f.url, { session_id: "s", cwd: "/tmp", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `echo "${KEY}" > ~/.claude/iron-office-api-key` }, tool_response: "" });
  await runHook(home, f.url, { session_id: "s", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "export API_TOKEN=abc123 && curl -H 'Authorization: Bearer xyz.789' x" } });
  await runHook(home, f.url, { session_id: "s", hook_event_name: "SubagentStop", agent_type: "" });
  await runHook(home, f.url, { session_id: "s", hook_event_name: "SubagentStart", agent_type: "iron-research", agent_id: "a1" });
  await runHook(home, f.url, { session_id: "s", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "🎉".repeat(300) } });
  const code = await runHook(home, f.url, "");
  await runHook(casa(null), f.url, { tool_name: "Bash", tool_input: { command: "ls" } });
  const sent = f.calls.map((c) => JSON.stringify(c.body)).join("\n");
  check("Write manda só o caminho, nunca o conteúdo", f.calls[0]?.body?.tool_input?.file_path === "/app/.env" && !sent.includes("sk_live") && !sent.includes("xxxxxxxxxx"));
  check("a chave do Iron Office nunca sai", !sent.includes(KEY));
  check("token e Bearer redigidos", !sent.includes("abc123") && !sent.includes("xyz.789"), f.calls[2] && JSON.stringify(f.calls[2].body.tool_input));
  check("SubagentStop sem agente não vira evento", !f.calls.some((c) => c.body?.tool_name === "SubagentStop"));
  check("SubagentStart leva o nome do agente", f.calls.some((c) => c.body?.tool_input?.agent_type === "iron-research"));
  const emoji = f.calls.find((c) => (c.body?.tool_input?.command ?? "").startsWith("🎉"));
  check("corte não parte emoji ao meio", !!emoji && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji.body.tool_input.command));
  check("stdin vazio sai 0", code === 0);
  check("sem chave não envia nada (5 = os 5 envios válidos acima)", f.calls.length === 5, `chamadas: ${f.calls.length}`);
  f.srv.close();
}

for (const d of lixo) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    // nada
  }
}
console.log(`\niron-office: ${total - falhas}/${total} ok`);
process.exit(falhas ? 1 : 0);
