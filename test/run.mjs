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
      const send = () => {
        res.writeHead(r.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(r.json ?? {}));
        r.onSent?.();
      };
      if (r.delay) setTimeout(send, r.delay);
      else send();
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

async function runHook(home, url, input, channel = "1", hookPath = HOOK) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [hookPath], {
      env: { ...process.env, HOME: home, USERPROFILE: home, IRON_OFFICE_URL: url, IRON_OFFICE_CHANNEL: channel },
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
  const hook = (input) => runHook(home, f.url, input);
  const bash = (command, tool_response = "") =>
    hook({ session_id: "s", cwd: "/tmp", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response });
  const big = "STRIPE_SECRET=sk_live_ABC123XYZ\n" + "x".repeat(200_000);

  await hook({ session_id: "s", cwd: "/tmp", hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/app/.env", content: big }, tool_response: big });
  await bash(`echo "${KEY}" > ~/.claude/iron-office-api-key`);
  await bash("export API_TOKEN=abc123 && curl -H 'Authorization: Bearer xyz.789' x");
  // casos que vazaram na rodada 2 do gate
  await bash("cat config.json", { stdout: '{"api_key": "abcd1234efgh", "password":"p4ssw0rd", "client_secret": "zzz"}' });
  await bash("mysql -u root -phunter2 db && psql --password hunter3 && tool --token=tok999");
  await bash("curl -u admin:s3cretpass https://x");
  await bash("aws configure set aws_secret_access_key wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY && echo AKIAIOSFODNN7EXAMPLE");
  await bash(`node -e 'x({"apiKey": "inline777"})'`);
  await bash("mkdir -p dist && npm run build");
  await hook({ session_id: "s", hook_event_name: "PostToolUse", tool_name: "WebFetch", tool_input: { url: "https://hooks.exemplo.com/T0/B1/segredoNoCaminho?token=q1" } });
  await hook({ session_id: "s", hook_event_name: "SubagentStop", agent_type: "" });
  await hook({ session_id: "s", hook_event_name: "SubagentStart", agent_type: "iron-research", agent_id: "a1" });
  await bash("🎉".repeat(300));
  const code = await runHook(home, f.url, "");
  const antesSemChave = f.calls.length;
  await runHook(casa(null), f.url, { tool_name: "Bash", tool_input: { command: "ls" } });

  const sent = f.calls.map((c) => JSON.stringify(c.body)).join("\n");
  const cmd = (needle) => f.calls.find((c) => (c.body?.tool_input?.command ?? "").includes(needle))?.body.tool_input.command;
  check("Write manda só o caminho, nunca o conteúdo", f.calls[0]?.body?.tool_input?.file_path === "/app/.env" && !sent.includes("sk_live") && !sent.includes("xxxxxxxxxx"));
  check("a chave do Iron Office nunca sai", !sent.includes(KEY));
  check("token e Bearer redigidos", !sent.includes("abc123") && !sent.includes("xyz.789"));
  check("a resposta das ferramentas nunca sai", f.calls.every((c) => c.body?.tool_response === null) && !sent.includes("abcd1234efgh") && !sent.includes("p4ssw0rd"));
  check("--password, -pSENHA e --token= redigidos", !/hunter2|hunter3|tok999/.test(sent), cmd("mysql"));
  check("curl -u usuario:senha redigido", !sent.includes("s3cretpass"), cmd("curl -u"));
  check("chaves da AWS redigidas", !sent.includes("wJalrXUtnFEMI") && !sent.includes("AKIAIOSFODNN7EXAMPLE"), cmd("aws"));
  check('"campo": "valor" com aspas redigido', !sent.includes("inline777"), cmd("node -e"));
  check("comando sem segredo passa inteiro (mkdir -p)", cmd("mkdir") === "mkdir -p dist && npm run build", cmd("mkdir"));
  const fetch = f.calls.find((c) => c.body?.tool_name === "WebFetch");
  check("WebFetch manda só o domínio", fetch?.body?.tool_input?.url === "https://hooks.exemplo.com" && !sent.includes("segredoNoCaminho"), JSON.stringify(fetch?.body?.tool_input));
  check("SubagentStop sem agente não vira evento", !f.calls.some((c) => c.body?.tool_name === "SubagentStop"));
  check("SubagentStart leva o nome do agente", f.calls.some((c) => c.body?.tool_input?.agent_type === "iron-research"));
  // 0.3.8: todo evento leva a versão do hook (a do plugin.json); o site recusa evento sem ela
  const ver = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8")).version;
  check("todo evento leva hook_version = versão do plugin.json", f.calls.length > 0 && f.calls.every((c) => c.body?.hook_version === ver), JSON.stringify(f.calls.map((c) => c.body?.hook_version)));
  const emoji = f.calls.find((c) => (c.body?.tool_input?.command ?? "").startsWith("🎉"));
  check("corte não parte emoji ao meio", !!emoji && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji.body.tool_input.command));
  check("stdin vazio sai 0", code === 0);
  check("sem chave não envia nada", f.calls.length === antesSemChave);
  f.srv.close();
}

// ─── 7b. hook sem plugin.json vai sem versão (0.3.9) ────────────────────
{
  console.log("hook sem plugin.json");
  const f = await fakeOffice(() => ({ json: {} }));
  const home = casa();
  const dir = mkdtempSync(join(tmpdir(), "iron-office-sem-manifesto-"));
  mkdirSync(join(dir, "hooks"));
  writeFileSync(join(dir, "hooks", "post-event.mjs"), readFileSync(HOOK));
  await runHook(home, f.url, { session_id: "s", cwd: "/tmp", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } }, "1", join(dir, "hooks", "post-event.mjs"));
  check("evento sai, mas sem hook_version (nada de versão fixa no código)", f.calls.length === 1 && !("hook_version" in (f.calls[0].body ?? {})), JSON.stringify(f.calls.map((c) => c.body?.hook_version)));
  rmSync(dir, { recursive: true, force: true });
  f.srv.close();
}

// ─── 8. hook fora do canal não manda nada (onda 3.1, bloqueador B) ──────
{
  console.log("hook fora do canal");
  const f = await fakeOffice(() => ({ json: {} }));
  const home = casa();
  const ev = (cmd) => ({ session_id: "s", cwd: "/outro/projeto", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: cmd } });
  for (const v of ["", "0", "true"]) await runHook(home, f.url, ev(`ls ${v}`), v);
  await runHook(home, f.url, { session_id: "s", hook_event_name: "Stop" }, "");
  check("sem IRON_OFFICE_CHANNEL=1: 0 requisições", f.calls.length === 0, JSON.stringify(f.calls.map((c) => c.body)));
  await runHook(home, f.url, ev("ls canal"), "1");
  check("com IRON_OFFICE_CHANNEL=1: manda", f.calls.length === 1);
  f.srv.close();
}

// ─── 8b. evento leva o id do agente que o gerou (onda 4) ────────────────
{
  console.log("hook com agente");
  const f = await fakeOffice(() => ({ json: {} }));
  const home = casa();
  await runHook(home, f.url, { session_id: "s", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo dentro" }, agent_id: "ab616b39dd66778d0", agent_type: "iron-auditor" });
  await runHook(home, f.url, { session_id: "s", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo fora" } });
  const dentro = f.calls.find((c) => c.body?.tool_input?.command === "echo dentro")?.body.tool_input;
  const fora = f.calls.find((c) => c.body?.tool_input?.command === "echo fora")?.body.tool_input;
  check("ferramenta dentro do subagente sai com agent_id e agent_type", dentro?.agent_id === "ab616b39dd66778d0" && dentro?.agent_type === "iron-auditor", JSON.stringify(dentro));
  check("ferramenta do Iron sai sem agent_id", !!fora && !("agent_id" in fora) && !("agent_type" in fora), JSON.stringify(fora));
  f.srv.close();
}

// ─── 9. deliver salva a entrega e devolve o link (onda 3.1, bloqueador A) ─
{
  console.log("deliver");
  const f = await fakeOffice((c) => {
    if (c.path === "/api/chat/pull") return { json: { dashboard_open: true, messages: [] } };
    if (c.path === "/api/deliverables") return { json: { ok: true, deliverable: { id: "d-123", title: c.body.title } } };
  });
  const call = (s, id, args) => s.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "deliver", arguments: args } });
  const result = (s, id) => s.out.find((o) => o.msg.id === id)?.msg.result;

  const s = startServer(casa(), f.url, { IRON_OFFICE_CHANNEL: "1" });
  s.handshake();
  await sleep(1500);
  s.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  call(s, 3, { title: "Auditoria de exemplo.com", agent: "iron-auditor", content: "# Relatório\nnota 7", type: "auditoria" });
  call(s, 4, { title: "", agent: "iron-auditor", content: "x" });
  await sleep(800);
  const tools = s.out.find((o) => o.msg.id === 2)?.msg.result?.tools?.map((t) => t.name) ?? [];
  check("tools/list tem reply, deliver e status", ["reply", "deliver", "status"].every((n) => tools.includes(n)), tools.join(","));
  const post = f.calls.filter((c) => c.path === "/api/deliverables");
  check(
    "POST /api/deliverables com a chave e os campos da rota",
    post.length === 1 && post[0].key === KEY && post[0].body.agent_name === "iron-auditor" && post[0].body.title === "Auditoria de exemplo.com" &&
      post[0].body.content === "# Relatório\nnota 7" && JSON.stringify(post[0].body.tags) === '["auditoria"]',
    JSON.stringify(post),
  );
  const r3 = result(s, 3);
  let got = {};
  try { got = JSON.parse(r3?.content?.[0]?.text ?? "{}"); } catch {}
  check("devolve { id, url } com /deliverables?id=", got.id === "d-123" && got.url === `${f.url}/deliverables?id=d-123` && !r3?.isError, JSON.stringify(r3));
  check("título vazio = erro, sem POST", result(s, 4)?.isError === true && post.length === 1);
  check("sem card, o POST não leva o campo", !("card" in post[0].body));
  const card = { kind: "auditoria", score: 6.5, summary: "s", items: [1, 2, 3, 4, 5].map((n) => ({ title: `t${n}`, why: "w", effort: "e", action: `a${n}` })) };
  call(s, 6, { title: "Com cartão", agent: "iron-auditor", content: "c", card });
  await sleep(600);
  const comCard = f.calls.filter((c) => c.path === "/api/deliverables").at(-1);
  check("card vai no corpo do POST", comCard?.body?.title === "Com cartão" && comCard.body.card?.score === 6.5, JSON.stringify(comCard?.body?.card));
  check("card com 5 itens chega como está (quem poda é o servidor)", comCard?.body?.card?.items?.length === 5);
  s.p.kill();

  const idle = startServer(casa(), f.url, { IRON_OFFICE_CHANNEL: "" });
  idle.handshake();
  await sleep(1500);
  call(idle, 5, { title: "t", agent: "iron-auditor", content: "c" });
  await sleep(500);
  check("fora do canal: deliver recusa e não salva nada", result(idle, 5)?.isError === true && f.calls.filter((c) => c.path === "/api/deliverables").length === 2);
  idle.p.kill();
  f.srv.close();
}

// ─── 10. shop_status / shop_query: a loja pelo plugin, em qualquer sessão (onda 6) ─
{
  console.log("loja Shopify");
  const f = await fakeOffice((c) => {
    if (c.path === "/api/chat/pull") return { json: { dashboard_open: true, messages: [] } };
    if (c.path === "/api/shopify/graphql" && c.method === "GET") return { json: { connected: true, shopDomain: "loja.myshopify.com" } };
    if (c.path === "/api/shopify/graphql" && c.method === "POST") return { json: { data: { shop: { name: "Loja" } } } };
  });
  const call = (s, id, name, args) => s.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const result = (s, id) => s.out.find((o) => o.msg.id === id)?.msg.result;

  // fora do canal (modo idle): é como o aluno usa o iron-shopify num `claude` comum
  const s = startServer(casa(), f.url, { IRON_OFFICE_CHANNEL: "" });
  s.handshake();
  await sleep(1500);
  call(s, 2, "shop_status", {});
  call(s, 3, "shop_query", { query: "query($n:Int!){ products(first:$n){ edges { node { id } } } }", variables: { n: 3 } });
  call(s, 4, "shop_query", { query: "  " });
  await sleep(800);
  const get = f.calls.filter((c) => c.path === "/api/shopify/graphql" && c.method === "GET");
  const post = f.calls.filter((c) => c.path === "/api/shopify/graphql" && c.method === "POST");
  check("shop_status faz GET com x-api-key", get.length === 1 && get[0].key === KEY && /loja\.myshopify\.com/.test(result(s, 2)?.content?.[0]?.text ?? ""), JSON.stringify(result(s, 2)));
  check("shop_query manda { query, variables } no POST", post.length === 1 && post[0].key === KEY && post[0].body.variables?.n === 3 && /products/.test(post[0].body.query), JSON.stringify(post));
  check("shop_query sem query = erro, sem rede", result(s, 4)?.isError === true && post.length === 1);
  check("as duas respondem fora do canal (modo idle)", !result(s, 2)?.isError && !result(s, 3)?.isError && /Loja/.test(result(s, 3)?.content?.[0]?.text ?? ""), JSON.stringify(result(s, 3)));
  s.p.kill();
  f.srv.close();
}

// ─── 11. despedida: fechar o canal anoitece o escritório na hora (0.3.7) ─
{
  console.log("despedida (bye)");
  const pres = (calls) => calls.filter((c) => c.path === "/api/chat/presence");
  for (const mudo of [false, true]) {
    const f = await fakeOffice((c) => {
      if (c.path === "/api/chat/pull") return { json: { dashboard_open: true, messages: [] } };
      if (c.path === "/api/chat/presence" && c.body?.bye && mudo) return { hang: true };
    });
    const s = startServer(casa(), f.url, { IRON_OFFICE_CHANNEL: "1" });
    s.handshake();
    await sleep(1500);
    const sid = pres(f.calls)[0]?.body?.session_id;
    const t0 = Date.now();
    const saiu = new Promise((r) => s.p.on("exit", () => r(Date.now() - t0)));
    s.p.stdin.end();
    const ms = await Promise.race([saiu, sleep(4000).then(() => Infinity)]);
    // 0.3.8: o POST sai do filho solto (bye.mjs), que leva uns 100-300 ms pra subir o node
    for (let i = 0; i < 150 && !pres(f.calls).some((c) => c.body?.bye === true); i++) await sleep(20);
    const bye = pres(f.calls).filter((c) => c.body?.bye === true);
    const tag = mudo ? "site mudo" : "site ok";
    check(`${tag}: stdin end manda 1 bye com o session_id da presença`, bye.length === 1 && !!sid && bye[0].body.session_id === sid && bye[0].key === KEY, JSON.stringify(bye));
    check(`${tag}: sai em <= 2 s`, ms <= 2000, `${ms} ms`);
    if (ms === Infinity) s.p.kill();
    f.srv.close();
  }
  // batimento em voo na hora do fechamento: o bye espera ele responder, pra chegar por último
  {
    const marks = [];
    const f = await fakeOffice((c) => {
      if (c.path === "/api/chat/pull") return { json: { dashboard_open: true, messages: [] } };
      if (c.path === "/api/chat/presence" && c.body?.bye) { marks.push(["bye", Date.now()]); return { json: {} }; }
      if (c.path === "/api/chat/presence") return { delay: 300, json: {}, onSent: () => marks.push(["presença respondida", Date.now()]) };
    });
    const s = startServer(casa(), f.url, { IRON_OFFICE_CHANNEL: "1" });
    s.handshake();
    // fecha assim que o 1º batimento chega no site (ele segura 300 ms a resposta): o batimento está em voo
    for (let i = 0; i < 100 && !f.calls.some((c) => c.path === "/api/chat/presence"); i++) await sleep(20);
    const saiu = new Promise((r) => s.p.on("exit", r));
    s.p.stdin.end();
    await Promise.race([saiu, sleep(3000)]);
    for (let i = 0; i < 150 && !marks.some((m) => m[0] === "bye"); i++) await sleep(20);
    const ordem = marks.map((m) => m[0]);
    check("bye chega depois do batimento em voo", ordem.at(-1) === "bye" && ordem.includes("presença respondida"), JSON.stringify(ordem));
    f.srv.close();
  }
  // sessão comum (sem o canal) não se despede: não é ela que marca presença
  const f = await fakeOffice(() => ({ json: {} }));
  const idle = startServer(casa(), f.url, { IRON_OFFICE_CHANNEL: "" });
  idle.handshake();
  await sleep(1200);
  const saiu = new Promise((r) => idle.p.on("exit", r));
  idle.p.stdin.end();
  await Promise.race([saiu, sleep(3000)]);
  await sleep(1500); // tempo de um filho solto, se tivesse sido criado, chegar
  check("fora do canal: fechar não manda bye", pres(f.calls).length === 0, JSON.stringify(f.calls));
  f.srv.close();
}

// ─── 12. despedida solta (0.3.8): sobrevive ao fechar a janela ─────────
{
  console.log("despedida solta (bye.mjs)");
  const BYE = join(ROOT, "dist", "bye.mjs");
  const pres = (calls) => calls.filter((c) => c.path === "/api/chat/presence");
  // (a) o fechamento cria o filho com o bye.mjs; a chave não vai no argv (o `ps` mostraria)
  {
    const f = await fakeOffice((c) => (c.path === "/api/chat/pull" ? { json: { dashboard_open: true, messages: [] } } : { json: {} }));
    const home = casa();
    const spy = join(home, "bye-spy.jsonl");
    const s = startServer(home, f.url, { IRON_OFFICE_CHANNEL: "1", IRON_OFFICE_BYE_SPY: spy, NODE_ENV: "test" });
    s.handshake();
    await sleep(1500);
    const saiu = new Promise((r) => s.p.on("exit", r));
    s.p.stdin.end();
    await Promise.race([saiu, sleep(3000)]);
    let linhas = [];
    for (let i = 0; i < 150 && !linhas.length; i++) { await sleep(20); try { linhas = readFileSync(spy, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { /* ainda não */ } }
    const sid = pres(f.calls)[0]?.body?.session_id;
    check("fechar cria 1 filho bye.mjs com o session_id da presença", linhas.length === 1 && linhas[0].session_id === sid && linhas[0].base === f.url && linhas[0].has_key === true, JSON.stringify(linhas));
    check("a chave não vai no argv do filho", Array.isArray(linhas[0]?.argv) && linhas[0].argv.length === 3 && !linhas[0].argv.join(" ").includes("iok_"), JSON.stringify(linhas[0]?.argv));
    f.srv.close();
  }
  // (b) fechar a janela = o grupo inteiro morre logo depois do SIGHUP. Com um batimento em voo (o site
  // segura a resposta), a 0.3.7 ficava esperando ele dentro do processo e morria sem despedir; o filho
  // solto nasce na hora, espera do lado de fora e despede (controle negativo: falha na 0.3.7).
  if (process.platform !== "win32") {
    const f = await fakeOffice((c) => {
      if (c.path === "/api/chat/pull") return { json: { dashboard_open: true, messages: [] } };
      if (c.path === "/api/chat/presence" && !c.body?.bye) return { delay: 1500, json: {} };
      return { json: {} };
    });
    const p = spawn(process.execPath, [SERVER], {
      env: { ...process.env, HOME: casa(), IRON_OFFICE_URL: f.url, IRON_OFFICE_CHANNEL: "1" },
      stdio: ["pipe", "ignore", "ignore"],
      detached: true, // grupo próprio, como a aba do terminal
    });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    // espera o 1º batimento chegar no site (ele fica em voo por 1,5 s)
    for (let i = 0; i < 150 && !pres(f.calls).length; i++) await sleep(20);
    const t0 = Date.now();
    // fechar a janela: o terminal manda SIGHUP ao grupo e, logo depois, quem sobrou morre de vez
    process.kill(-p.pid, "SIGHUP");
    await sleep(60);
    try { process.kill(-p.pid, "SIGKILL"); } catch { /* o grupo já tinha saído */ }
    for (let i = 0; i < 150 && !pres(f.calls).some((c) => c.body?.bye === true); i++) await sleep(20);
    const ms = Date.now() - t0;
    check("SIGHUP + SIGKILL no grupo com batimento em voo: o bye chega em <= 3 s", pres(f.calls).some((c) => c.body?.bye === true) && ms <= 3000, `${ms} ms`);
    try { process.kill(-p.pid, "SIGKILL"); } catch { /* já saiu */ }
    f.srv.close();
  }
  // (d) sem o bye.mjs ao lado (instalação pela metade): despede do próprio processo, como na 0.3.7
  {
    const f = await fakeOffice((c) => (c.path === "/api/chat/pull" ? { json: { dashboard_open: true, messages: [] } } : { json: {} }));
    const dir = mkdtempSync(join(tmpdir(), "iron-office-sem-bye-"));
    lixo.push(dir);
    writeFileSync(join(dir, "server.mjs"), readFileSync(SERVER));
    const p = spawn(process.execPath, [join(dir, "server.mjs")], { env: { ...process.env, HOME: casa(), IRON_OFFICE_URL: f.url, IRON_OFFICE_CHANNEL: "1" }, stdio: ["pipe", "ignore", "pipe"] });
    let err = ""; p.stderr.on("data", (c) => (err += c));
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await sleep(1500);
    const saiu = new Promise((r) => p.on("exit", r));
    p.stdin.end();
    await Promise.race([saiu, sleep(3000)]);
    check("sem bye.mjs: despede do próprio processo e avisa no log", pres(f.calls).some((c) => c.body?.bye === true) && /bye\.mjs ausente/.test(err), err.slice(-200));
    f.srv.close();
  }
  // (c) bye.mjs sozinho: 1 POST com bye; com o site mudo sai em <= 3 s, código 0
  for (const mudo of [false, true]) {
    const f = await fakeOffice((c) => (mudo ? { hang: true } : { json: {} }));
    const t0 = Date.now();
    const code = await new Promise((r) => {
      const c = spawn(process.execPath, [BYE, f.url, "sessao-x"], { env: { ...process.env, HOME: casa() }, stdio: "ignore" });
      c.on("exit", r);
    });
    const ms = Date.now() - t0;
    const posts = pres(f.calls);
    check(`bye.mjs ${mudo ? "site mudo" : "site ok"}: 1 POST bye e sai 0 em <= 3 s`, code === 0 && ms <= 3000 && posts.length === 1 && posts[0].body.bye === true && posts[0].body.session_id === "sessao-x" && posts[0].key === KEY, `${code} ${ms} ms ${JSON.stringify(posts)}`);
    f.srv.close();
  }
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
