// 0.34.0 (onda 68): ligar a Meta pelo site, sem terminal.
// O site manda só a intenção `meta: conectar`; daqui saem SÓ comandos fixos (nenhum texto da mensagem vira argumento):
//   claude mcp get meta-ads                                                   → estado
//   claude mcp add --scope user --transport http meta-ads https://mcp.facebook.com/ads   → só se não existir
//   claude mcp login meta-ads                                                 → o login no Facebook
// Medido em 24/11 (Claude Code 2.1.331): o `login` recusa rodar sem terminal ("this isn't an interactive terminal").
// No Mac ele roda por baixo do `script -q /dev/null` (terminal invisível que vem no sistema): o navegador abre, o
// aluno clica "Continuar" e o comando sai com 0. Windows não foi medido: abre uma janela do cmd já com o comando
// (caminho B) e o plugin acompanha pelo `get`. Linux: `script -q -c`, sem medida.
import { execFile, spawn } from "node:child_process";

export const META_NAME = "meta-ads";
export const META_URL = "https://mcp.facebook.com/ads";
export const META_STATES = ["absent", "needs_auth", "connected", "unknown"];
export const LOGIN_TIMEOUT_MS = 5 * 60_000;
const STATUS_TTL_MS = 60_000;
const GET_TIMEOUT_MS = 30_000;

/** Lê a saída do `claude mcp get meta-ads` pelos textos medidos (D5). code = código de saída (null = não rodou). */
export function parseMetaStatus(stdout, code) {
  const out = String(stdout ?? "");
  if (/No MCP server named/i.test(out)) return "absent";
  const m = out.match(/^\s*Status:\s*(.+)$/im);
  if (m) {
    const s = m[1];
    // gate r1: "Disconnected", "Not connected" e "Failed to connect" nunca viram conectada; só a palavra Connected sozinha
    if (/needs authentication/i.test(s)) return "needs_auth";
    if (!/(dis|not\s*|failed)/i.test(s) && /(^|[^a-z])connected\b/i.test(s)) return "connected";
    return "unknown"; // "✘ Failed to connect" e o que vier de novo: não adivinha
  }
  if (code === 1 && !out.trim()) return "unknown";
  return "unknown";
}

/** Link do Facebook que o `login` imprime (pra mandar de novo no chat se a aba não abriu). Só facebook.com/…/dialog/oauth. */
export function findOauthUrl(text) {
  const m = String(text ?? "").match(/https:\/\/www\.facebook\.com\/v\d+(?:\.\d+)?\/dialog\/oauth\?[^\s\x07\x1b"'<>]+/);
  return m ? m[0] : null;
}

/** Comando do login por sistema. Fixo: nada de fora entra aqui. */
export function loginCommand(platform = process.platform, bin = "claude") {
  if (platform === "darwin") return { mode: "pty", cmd: "script", args: ["-q", "/dev/null", bin, "mcp", "login", META_NAME] };
  // linha inteira fixa, passada sem as aspas do Node (windowsVerbatimArguments)
  if (platform === "win32") return { mode: "window", cmd: "cmd.exe", args: ["/d", "/s", "/c", `start "Iron Office - Meta" cmd.exe /k claude mcp login ${META_NAME}`], verbatim: true };
  return { mode: "pty", cmd: "script", args: ["-q", "-c", `${bin} mcp login ${META_NAME}`, "/dev/null"] };
}

function defaultExec(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout, windowsHide: true, shell: process.platform === "win32" }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : null) : 0, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

/**
 * Estado + login da Meta. `deps` troca o mundo real nos testes: exec(cmd,args,timeout) → {code,out};
 * spawn(cmd,args,opts) → processo; now() → ms; platform.
 */
export function createMeta(deps = {}) {
  const exec = deps.exec ?? defaultExec;
  const spawnFn = deps.spawn ?? spawn;
  const now = deps.now ?? (() => Date.now());
  const platform = deps.platform ?? process.platform;
  // testes apontam pra um `claude` falso (variável só do ambiente do processo, nunca da mensagem)
  const bin = deps.bin ?? (process.env.IRON_OFFICE_CLAUDE_BIN || "claude");
  const timeoutMs = deps.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? 3000;
  let cache = null; // { state, at }
  let refreshing = null;
  let running = null; // login em andamento (uma vez por vez)
  // gate r1 (Windows): o `start` solta a janela do cmd e o kill não a alcança; depois do tempo-limite a janela pode seguir
  // esperando o Facebook. Até 10 min depois de abrir, o próximo clique responde "já estou esperando" em vez de abrir outra.
  let windowUntil = 0;

  async function status({ fresh = false } = {}) {
    if (!fresh && cache && now() - cache.at < STATUS_TTL_MS) return cache.state;
    if (refreshing) return refreshing;
    refreshing = exec(bin, ["mcp", "get", META_NAME], GET_TIMEOUT_MS)
      .then(({ code, out }) => {
        const state = parseMetaStatus(out, code);
        cache = { state, at: now() };
        return state;
      })
      .catch(() => "unknown")
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  /** Último estado lido, sem rodar nada (pra presença). null = ainda não leu. */
  function cached() {
    return cache ? cache.state : null;
  }

  /**
   * Liga a Meta. on(evento, dado): "busy" (já tem um login esperando), "already" (já conectada),
   * "added" (instalou o conector), "opened" (navegador aberto; dado = link ou null), "window" (Windows: janela aberta).
   * Devolve "connected" | "timeout" | "failed" | "busy" | "already".
   */
  function connect(on = () => {}) {
    if (running || now() < windowUntil) { on("busy"); return Promise.resolve("busy"); }
    running = (async () => {
      let st = await status({ fresh: true });
      if (st === "connected") { on("already"); return "already"; }
      if (st === "absent") {
        const r = await exec(bin, ["mcp", "add", "--scope", "user", "--transport", "http", META_NAME, META_URL], GET_TIMEOUT_MS);
        if (r.code !== 0) return "failed";
        on("added");
        st = await status({ fresh: true });
        if (st === "absent") return "failed";
      }
      const { mode, cmd, args, verbatim } = loginCommand(platform, bin);
      let child;
      try {
        child = spawnFn(cmd, args, { stdio: mode === "pty" ? ["ignore", "pipe", "pipe"] : "ignore", windowsHide: mode !== "window", detached: false, ...(verbatim ? { windowsVerbatimArguments: true } : {}) });
      } catch {
        return "failed";
      }
      return await new Promise((resolve) => {
        let done = false;
        let buf = "";
        let sentLink = false;
        let exited = false; // gate r2: processo já saiu (a 2ª leitura do get no exit 0 não pode deixar o "abri" escapar)
        const finish = (r) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          clearTimeout(opened);
          clearInterval(poll);
          try { if (child.exitCode === null) child.kill(); } catch { /* já saiu */ }
          resolve(r);
        };
        const timer = setTimeout(() => finish("timeout"), timeoutMs);
        // gate r1: "abri o Facebook" só se o processo seguiu vivo 1,5 s (claude ausente ou sem o `login` sai antes)
        // e nunca depois do fim; o link chega junto se já tiver aparecido na saída
        const opened = setTimeout(() => {
          if (done || exited || sentLink || mode === "window") return;
          sentLink = true;
          on("opened", findOauthUrl(buf));
        }, 1500);
        // Windows (janela própria) e garantia geral: o estado que manda é o `get`
        const poll = setInterval(async () => {
          if ((await status({ fresh: true })) === "connected") finish("connected");
        }, pollMs);
        if (mode === "window") { windowUntil = now() + 10 * 60_000; on("window"); }
        const onData = (d) => {
          buf = (buf + String(d)).slice(-20_000);
          if (!sentLink && !done) {
            const url = findOauthUrl(buf);
            if (url) { sentLink = true; on("opened", url); }
          }
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("error", () => finish("failed"));
        child.on("exit", async (code) => {
          exited = true;
          if (mode === "window" || done) return; // o `start` sai na hora (quem decide é o poll); depois do fim, nada
          let st2 = await status({ fresh: true });
          // gate r1: login saiu com 0 e o `get` ainda não viu: o token pode gravar com atraso; uma 2ª leitura
          if (st2 !== "connected" && code === 0) {
            await new Promise((r) => setTimeout(r, 2000));
            st2 = await status({ fresh: true });
          }
          finish(st2 === "connected" ? "connected" : "failed");
        });
      });
    })().finally(() => { running = null; });
    return running;
  }

  return { status, cached, connect, isRunning: () => running !== null };
}
