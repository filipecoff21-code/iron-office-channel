// Iron Office — porteiro de instalação (0.22.0, onda 54, Revisão 1).
// Gancho PreToolUse: antes de o Iron rodar um comando (Bash ou PowerShell) ou escrever um arquivo (Write/Edit/MultiEdit/
// NotebookEdit), olha se aquilo instala algo de FORA da casa. Se instala e o aluno ainda não liberou, BARRA e manda o Iron
// perguntar pelo `ask` (Estudar antes · Instalar mesmo assim · Não instalar), com os ids pt-estudar-<hash>,
// pt-instalar-<hash> e pt-nao-<hash> (o site e o ask só aceitam a-z, 0-9, _ e -, até 24 caracteres). Quem libera é o
// PLUGIN, ao receber o clique do aluno (src/server.mjs grava ~/.iron/porteiro/liberados.json), e o servidor só aceita o ask
// com o texto do modelo e o item batendo com o hash; o Iron não pode tocar na pasta nem na chave do porteiro.
//
// REVISÃO 1 (08/11, depois de 5 rodadas do gate): DETECTAR é separado de NOMEAR, e detectar só pode ganhar com texto a
// mais (regra do Filipe: mais texto nunca pode significar menos detecção). O comando é normalizado (N) e detectado por
// PRESENÇA de palavras (instalador e, depois dele no mesmo trecho, o verbo), sem tentar entender o shell. O nome do item é
// melhor esforço e nunca decide; "da casa" só passa calado quando o trecho é literal e todos os nomes estão na casa.
//
// MODELO DE AMEAÇA (R-1): freio pra um Iron cooperativo e pra injeção simples (um README que diz "rode npm i tal"). Barra o
// comando de instalação em qualquer forma plausível. NÃO promete segurar ofuscação deliberada: comando montado em
// variáveis, `$'\x6e'`, script gravado ou baixado num comando e rodado em outro, binário copiado com outro nome, código Python/Node que instala
// por dentro. Consequência da D-4: o Iron pode editar o package.json e rodar `npm install` seco, e isso instala o que ele pôs lá. Não vê o que o aluno digita no próprio terminal. Não cobre winget, choco, scoop, apt, cargo, go install, gem
// nem Install-Module. Separador de shell entre aspas no meio dos pacotes (`npm i a ";" b`) parte o trecho: ofuscação, limite.
// A pasta do porteiro: barra o caminho .iron/porteiro, os nomes liberados.json e porteiro/modo, e .iron + porteiro no mesmo
// comando ou com a pasta atual dentro de ~/.iron. Montar o caminho em variáveis ou glob (~/.ir?n/p*) é ofuscação: limite.
// Erro ou tempo estourado no próprio porteiro: deixa passar (nunca trava a sessão).
// Nada sai da máquina: o registro fica em ~/.iron/porteiro/registro.jsonl.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { porteiroHash, porteiroMode, porteiroPergunta, PORTEIRO_ROTULOS, PORTEIRO_SEM_NOME, redactKeys } from "./shared.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const hashOf = porteiroHash;

function loadCasa() {
  try {
    const c = JSON.parse(readFileSync(join(HERE, "casa.json"), "utf8"));
    const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
    return { pacotes: new Set(arr(c.pacotes)), escopos: arr(c.escopos), dominios: arr(c.dominios), plugins: new Set(arr(c.plugins)) };
  } catch {
    return { pacotes: new Set(), escopos: [], dominios: [], plugins: new Set() };
  }
}
const CASA = loadCasa();

const T = {
  npm: "pacote npm", exec: "pacote executado", py: "pacote Python", link: "pacote de um link", local: "pacote de uma pasta",
  brew: "programa do Homebrew", git: "repositório git", script: "script baixado ou gerado", mcp: "conector do Claude",
  plugin: "plugin do Claude Code", market: "loja de plugins", ext: "extensão do VS Code", file: "arquivo que dá ordens ao Iron",
};

// ─── N: normalização (função pura) ──────────────────────────────────────
// Palavras que, vindo de um caminho (/usr/local/bin/npm, C:/…/npm.cmd), viram o nome base.
const KNOWN = new Set([
  "npm", "pnpm", "yarn", "bun", "corepack", "npx", "pnpx", "bunx", "uvx", "pipx", "pip", "pip3", "uv", "python", "python3", "py",
  "brew", "git", "claude", "code", "cursor", "sh", "bash", "zsh", "dash", "ksh", "fish", "iex", "node", "pwsh", "powershell",
  "perl", "ruby", "curl", "wget", "iwr", "irm", "eval", "sudo", "env", "xargs", "source",
]);
function baseWord(t) {
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(t)) return t;
  const b = t.slice(t.lastIndexOf("/") + 1).replace(/\.(cmd|exe|ps1|bat)$/, "");
  return KNOWN.has(b) ? b : t;
}
function finish(s) {
  s = s.replace(/["'`]/g, "").replace(/\$\(|\$\{|<\(|>\(|[$(){}]/g, " ").replace(/\r/g, "").toLowerCase();
  // redirecionamento colado na palavra (npm i>/dev/null evil) vira palavra própria: só acrescenta palavra, nunca tira
  s = s.replace(/(\d*&?>>?&?\d*|<<?)/g, " $1 ");
  return s
    .split("\n")
    .map((line) => line.split(/[ \t]+/).filter(Boolean).map(baseWord).join(" "))
    .join("\n");
}
/** N(cmd): sem barra invertida, sem aspas e crases, `$(`/`${`/`$`/`(`/`)`/`{`/`}`/`<(`/`>(` viram espaço, minúsculas,
 *  caminho de comando conhecido vira o nome base. Nunca junta nem tira palavra além disso. */
export const N = (cmd) => finish(String(cmd).replace(/\\\r?\n/g, " ").replace(/\\/g, ""));
// a mesma leitura com a barra invertida virando "/" (caminho do Windows: C:\…\npm.cmd → npm). Detectar = N ∪ N2.
export const N2 = (cmd) => finish(String(cmd).replace(/\\\r?\n/g, " ").replace(/\\/g, "/"));

// ─── trechos ────────────────────────────────────────────────────────────
// Divide em && || ; | & (solto) e quebra de linha. Devolve [{ text, pipeFromPrev }]. Funciona igual no texto cru e no
// normalizado (N não mexe nesses caracteres), então o i-ésimo trecho cru é o i-ésimo normalizado.
export function split(text) {
  const out = [];
  let cur = "";
  let pipe = false;
  const s = String(text);
  const push = (nextPipe) => {
    out.push({ text: cur, pipeFromPrev: pipe });
    cur = "";
    pipe = nextPipe;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const d = s[i + 1];
    if ((c === "&" && d === "&") || (c === "|" && d === "|")) { push(false); i++; continue; }
    if (c === "|") { push(true); if (d === "&") i++; continue; }
    if (c === ";" || c === "\n") { push(false); continue; }
    if (c === "&" && s[i - 1] !== ">" && s[i - 1] !== "<" && d !== ">") { push(false); continue; }
    cur += c;
  }
  push(false);
  return out;
}

// ─── detecção por trecho (tokens) ───────────────────────────────────────
const isFlag = (t) => t.startsWith("-");
const isRedir = (t) => /^(\d*|&)?(>>?|<<?|>&|<&)/.test(t);
const NAME_RE = /^[@a-z0-9._/~:-]+(@[a-z0-9.^~*+<>=-]+)?$/;
const isUrl = (t) => /^(https?:\/\/|git@|git\+|ssh:\/\/|git:\/\/)/.test(t);
const looksRepo = (t) => isUrl(t) || /^[\w.-]+\/[\w.-]+$/.test(t);
const isLocal = (t) => t === "." || t === ".." || /^(\.{1,2}\/|\/|~\/|file:|[a-z]:\/)/.test(t);

const NPM_FAM = new Set(["npm", "pnpm", "yarn", "bun", "corepack"]);
const NPM_VERBS = new Set(["i", "install", "isntall", "add", "ci", "dlx", "x", "exec", "create", "init", "link", "up", "update", "upgrade"]);
const EXECS = new Set(["npx", "pnpx", "bunx", "uvx", "pipx"]);
const isPip = (t) => /^pip\d*(\.\d+)?$/.test(t) || t === "uv"; // pip, pip3, pip3.11, uv (gate r6)
const PY_VERBS = new Set(["install", "add", "sync", "run"]);
const INTERP = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "iex", "invoke-expression", "node", "python", "python3", "pwsh", "powershell", "perl", "ruby"]);
const FETCH = new Set(["curl", "wget", "iwr", "irm", "invoke-webrequest", "invoke-restmethod", "fetch", "downloadstring", "downloadfile"]);
// `(New-Object Net.WebClient).DownloadString(…)` normalizado vira a palavra `.downloadstring` (ou `c.downloadstring` com variável)
const ehFetch = (t) => FETCH.has(t) || /\.download(string|file)$/.test(t);
const FETCH_INTERP = new Set(["sh", "bash", "zsh", "source", ".", "iex", "invoke-expression", "node", "python", "python3"]);
const PREFIX = new Set(["sudo", "env", "nohup", "command", "time", "exec", "builtin", "stdbuf", "nice", "timeout", "busybox", "xargs"]);
// flags cujo valor não é pacote (só pra decidir "da casa" e nomear; nunca pra detectar)
const VALUE_FLAGS = new Set(["--prefix", "--registry", "--cache", "--tag", "--workspace", "-w", "--loglevel", "--depth", "--filter", "-f", "-c", "--dir", "--cwd", "-r", "--requirement", "-e", "--editable", "-i", "--index-url", "--extra-index-url", "-t", "--target", "--scope", "-s", "--transport", "--env", "-h", "--header", "-b", "--branch", "-o", "--origin", "--otp"]);

/** argumentos depois do verbo que são nomes (pula flag, valor de flag conhecida, redirecionamento e o destino dele) */
function nomes(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") continue;
    if (isRedir(a)) { if (/^(\d*|&)?(>>?|<<?|>&|<&)$/.test(a)) i++; continue; }
    if (a.startsWith("#")) continue;
    if (isFlag(a)) { if (!a.includes("=") && VALUE_FLAGS.has(a)) i++; continue; }
    out.push(a);
  }
  return out;
}

/** argumentos depois do verbo, crus: só pula flag, redirecionamento (e o destino) e palavra de comentário. É o que decide
 *  (detectar e "da casa"); o `nomes` acima, que também pula valor de flag conhecida, só escolhe o nome que aparece. */
function crus(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") continue;
    if (isRedir(a)) { if (/^(\d*|&)?(>>?|<<?|>&|<&)$/.test(a)) i++; continue; }
    if (a.startsWith("#") || isFlag(a)) continue;
    out.push(a);
  }
  return out;
}

function bareName(t) {
  if (isUrl(t)) return t;
  if (t.startsWith("@")) {
    const i = t.indexOf("@", 1);
    return i > 0 ? t.slice(0, i) : t;
  }
  return t.replace(/@.*$/, "").replace(/\[.*$/, "").replace(/(==|>=|<=|~=|!=|>|<).*$/, "");
}
function createName(t) {
  const n = bareName(t);
  if (n.startsWith("@")) {
    const [scope, rest] = n.split("/");
    return rest ? `${scope}/create-${rest}` : `${scope}/create`;
  }
  return `create-${n}`;
}

function hostPath(u) {
  try {
    const x = new URL(u.replace(/^git\+/, ""));
    return (x.host + x.pathname).replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
  } catch {
    return null;
  }
}
function nomeNaCasa(n) {
  if (isUrl(n)) {
    const hp = hostPath(n);
    return !!hp && CASA.dominios.some((d) => hp === d || hp.startsWith(d + "/") || (!d.includes("/") && hp.split("/")[0] === d));
  }
  if (CASA.pacotes.has(n)) return true;
  return CASA.escopos.some((s) => n.startsWith(s + "/"));
}
/** compat com os testes e a varredura: item → é da casa? (usa a decisão do trecho quando ela veio junto) */
export function daCasa(x) {
  if (typeof x?.casa === "boolean") return x.casa;
  if (x?.tipo === T.file) return false;
  if (x?.tipo === T.plugin) return CASA.plugins.has(String(x.item).split("@")[0]);
  return nomeNaCasa(String(x?.item ?? ""));
}

const cut = (s) => (s.length > 80 ? s.slice(0, 80) : s).trim();
const semNome = (tipo, seg) => ({ item: cut(seg), tipo: tipo + PORTEIRO_SEM_NOME, casa: false });
const limpo = (n) => NAME_RE.test(n);

// binário que o projeto já tem: npx só roda, não baixa (sobe as pastas-pai, como o npx)
function localBin(cwd, bin) {
  if (!cwd || !/^[\w.@/-]+$/.test(bin) || bin.includes("..")) return false;
  const name = bareName(bin).split("/").pop();
  let dir = resolve(cwd);
  for (let i = 0; i < 40; i++) {
    if (["", ".cmd"].some((ext) => existsSync(join(dir, "node_modules", ".bin", name + ext)))) return true;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return false;
}

/** hits de UM trecho: tokens normalizados + o texto cru do trecho (pra saber se é literal) */
function detectSeg(tok, raw, ctx) {
  const hits = [];
  const segN = tok.join(" ");
  // "da casa" só com o comando literal e sem trocar a origem (gate r6: --registry=…, --index-url, motion@npm:evil, @github:, @https:, @file:)
  const origem = tok.some((t) => /^(--registry|--index-url|--extra-index-url|--userconfig|--globalconfig|-i|--index|--default-index|--find-links)(=|$)/.test(t) || /^@?[^@]+@[^@]*[:/]/.test(t));
  const literal = !/[$`\\]/.test(raw) && !tok.includes("eval") && !tok.includes("xargs") && !origem;
  const after = (i) => tok.slice(i + 1);

  // família npm: instalador e, em qualquer posição depois, o verbo
  for (let i = 0; i < tok.length; i++) {
    if (!NPM_FAM.has(tok[i])) continue;
    const v = tok.findIndex((t, k) => k > i && NPM_VERBS.has(t));
    if (v < 0) continue;
    const verb = tok[v];
    const cr = crus(after(v));
    const ns = nomes(after(v));
    // D-4: restaurar o projeto (npm install / ci seco, npm init -y) passa, só se literal e sem NENHUM argumento cru
    if (literal && cr.length === 0 && ["install", "i", "ci", "init"].includes(verb)) continue;
    if (verb === "create" || verb === "init") {
      const n = ns[0] ?? cr[0];
      if (!n || !limpo(n)) { hits.push(semNome(T.npm, segN)); continue; }
      const item = createName(n);
      hits.push({ item, tipo: T.npm, casa: literal && nomeNaCasa(item) });
      continue;
    }
    if (verb === "dlx" || verb === "x" || verb === "exec") {
      const n = ns[0] ?? cr[0];
      if (!n || !limpo(n)) { hits.push(semNome(T.exec, segN)); continue; }
      const item = bareName(n);
      hits.push({ item, tipo: T.exec, casa: literal && nomeNaCasa(item) });
      continue;
    }
    // um item por nome cru que não é da casa (liberar um não libera o outro); nome ilegível = o trecho inteiro
    if (!cr.length || !cr.every(limpo)) { hits.push(semNome(T.npm, segN)); continue; }
    for (const n of cr) {
      const x = isLocal(n) ? { item: n, tipo: T.local } : { item: bareName(n), tipo: isUrl(n) ? T.link : T.npm };
      hits.push({ ...x, casa: literal && x.tipo !== T.local && nomeNaCasa(x.item) });
    }
  }

  // executores: npx, pnpx, bunx, uvx, pipx
  for (let i = 0; i < tok.length; i++) {
    if (!EXECS.has(tok[i])) continue;
    let rest = after(i);
    if (tok[i] === "pipx") {
      const v = rest.findIndex((t) => t === "install" || t === "run");
      if (v >= 0) rest = rest.slice(v + 1);
    }
    let n = null;
    let viaP = false;
    for (let k = 0; k < rest.length; k++) {
      if ((rest[k] === "-p" || rest[k] === "--package") && rest[k + 1]) { n = rest[k + 1]; viaP = true; break; }
      if (rest[k].startsWith("--package=")) { n = rest[k].slice(10); viaP = true; break; }
      if (!isFlag(rest[k]) && !isRedir(rest[k])) { n = rest[k]; break; }
    }
    if (!n || !limpo(n)) { hits.push(semNome(T.exec, segN)); continue; }
    const item = bareName(n);
    const local = literal && !viaP && ["npx", "pnpx", "bunx"].includes(tok[i]) && localBin(ctx.cwd, n);
    hits.push({ item, tipo: tok[i] === "uvx" || tok[i] === "pipx" ? T.py : T.exec, casa: local || (literal && nomeNaCasa(item)) });
  }

  // Python: pip/pip3/uv e depois o verbo (python -m pip cai aqui pelo token pip)
  for (let i = 0; i < tok.length; i++) {
    if (!isPip(tok[i])) continue;
    const v = tok.findIndex((t, k) => k > i && PY_VERBS.has(t));
    if (v < 0) continue;
    const cr = crus(after(v));
    if (!cr.length || !cr.every(limpo)) { hits.push(semNome(T.py, segN)); continue; }
    for (const n of cr) hits.push(isLocal(n) ? { item: n, tipo: T.local, casa: false } : { item: bareName(n), tipo: T.py, casa: literal && nomeNaCasa(bareName(n)) });
  }

  // Homebrew
  for (let i = 0; i < tok.length; i++) {
    if (tok[i] !== "brew") continue;
    const v = tok.findIndex((t, k) => k > i && ["install", "tap", "cask", "bundle", "reinstall"].includes(t));
    if (v < 0) continue;
    const cr = crus(after(v)).filter((n) => n !== "install");
    if (!cr.length || !cr.every(limpo)) { hits.push(semNome(T.brew, segN)); continue; }
    for (const n of cr) hits.push({ item: n, tipo: T.brew, casa: literal && nomeNaCasa(n) });
  }

  // git clone
  for (let i = 0; i < tok.length; i++) {
    if (tok[i] !== "git") continue;
    const v = tok.findIndex((t, k) => k > i && t === "clone");
    if (v < 0) continue;
    const u = after(v).find(looksRepo);
    if (!u) { hits.push(semNome(T.git, segN)); continue; }
    const item = (isUrl(u) ? u : `https://github.com/${u}`).replace(/\.git$/, "").replace(/\/+$/, "");
    hits.push({ item, tipo: T.git, casa: literal && nomeNaCasa(item) });
  }

  // Claude Code: mcp add, plugin install/add/marketplace; VS Code/Cursor: --install-extension
  for (let i = 0; i < tok.length; i++) {
    if (tok[i] === "claude") {
      const m = tok.findIndex((t, k) => k > i && t === "mcp");
      const a = m >= 0 ? tok.findIndex((t, k) => k > m && (t === "add" || t === "add-json" || t === "add-from-claude-desktop")) : -1;
      if (a >= 0) {
        const rest = after(a);
        const dash = rest.indexOf("--");
        let item = rest.find(isUrl);
        if (!item && dash >= 0) {
          const inner = rest.slice(dash + 1);
          const e = inner.findIndex((t) => EXECS.has(t));
          const cand = nomes(e >= 0 ? inner.slice(e + 1) : inner)[0] ?? inner[0];
          if (cand && limpo(cand)) item = bareName(cand);
        }
        if (!item) {
          const ns = nomes(rest);
          item = ns[0] ? `mcp:${ns[0]}` : null;
        }
        if (!item) hits.push(semNome(T.mcp, segN));
        else hits.push({ item, tipo: T.mcp, casa: literal && tok[a] === "add" && nomeNaCasa(item) });
      }
      const p = tok.findIndex((t, k) => k > i && t === "plugin");
      const pv = p >= 0 ? tok.findIndex((t, k) => k > p && ["install", "add", "marketplace", "i"].includes(t)) : -1;
      if (pv >= 0) {
        const ns = nomes(after(pv)).filter((n) => n !== "add");
        const n = ns[0];
        if (!n) hits.push(semNome(T.plugin, segN));
        else if (tok[pv] === "marketplace") {
          const src = /^[\w.-]+\/[\w.-]+$/.test(n) ? `https://github.com/${n}` : n;
          hits.push({ item: src, tipo: T.market, casa: literal && nomeNaCasa(src) });
        } else hits.push({ item: n, tipo: T.plugin, casa: literal && CASA.plugins.has(n.split("@")[0]) });
      }
    }
    if (tok[i] === "code" || tok[i] === "cursor") {
      const k = tok.findIndex((t, j) => j > i && t.startsWith("--install-extension"));
      if (k >= 0) {
        const n = tok[k].includes("=") ? tok[k].split("=")[1] : tok[k + 1];
        hits.push(n ? { item: n, tipo: T.ext, casa: false } : semNome(T.ext, segN));
      }
    }
  }

  // baixar e rodar no mesmo trecho: sh <(curl …), source <(curl …), iex (irm …)
  if (tok.some(ehFetch) && tok.some((t) => FETCH_INTERP.has(t))) {
    const u = tok.find(isUrl);
    hits.push(u ? { item: u, tipo: T.script, casa: false } : semNome(T.script, segN));
  }
  return hits;
}

// Bash que GRAVA num caminho que vira skill/agente/plugin/conector/configuração do Claude. Por TRECHO (gate r6: a regra
// larga barrava `cd <skill> && npm install` das skills clone-*): caminho protegido + verbo de escrita no mesmo trecho, ou o
// caminho logo depois de > / >>. Continua monotônico: texto a mais no trecho nunca tira o verbo nem o caminho.
const PROTEGIDO_RE = /(?:~|\/users\/[^/\s]+|\/home\/[^/\s]+|[a-z]:\/users\/[^/\s]+|userprofile|home)\/\.claude\/(?:skills|agents|commands|plugins)(?:\/\S*)?$|\.claude\.json$|\.mcp\.json$|\.claude\/settings(?:\.local)?\.json$/;
const VERBO_ESCRITA = new Set(["cp", "mv", "ln", "rsync", "ditto", "tee", "touch", "mkdir", "unzip", "tar", "dd", "wget", "set-content", "out-file", "add-content", "copy-item", "move-item", "new-item", "expand-archive", "ni", "sc", "ac", "cpi", "mi"]);
function escreveProtegido(tok) {
  const alvos = tok.filter((t) => PROTEGIDO_RE.test(t));
  if (!alvos.length) return [];
  const verbo = tok.some((t, k) => VERBO_ESCRITA.has(t) || (k === 0 && t === "install") || ((t === "sed" || t === "perl") && tok.slice(k + 1).some((x) => x.startsWith("-i"))) || (t === "git" && tok.includes("clone")) || (t === "curl" && tok.some((x) => /^-[a-z]*o$|^--output/.test(x))));
  const redirecionado = tok.flatMap((t, k) => (/^(1|&)?>>?$/.test(t) && PROTEGIDO_RE.test(tok[k + 1] ?? "") ? [tok[k + 1]] : []));
  return verbo ? alvos : redirecionado;
}

// 54.1: baixar num arquivo e rodar no MESMO comando (`curl -o i.sh … && sh i.sh`), no comando inteiro e por presença. Só
// conta como "gravou" o destino de verdade (-o /dev/null e -o - não gravam nada), e o destino não conta como "rodou"
// (`curl -o ./foto.jpg …` sozinho não roda nada; se `./i.sh` aparece em outra posição, conta).
const SAIDA_CURL = /^-[a-z]*o|^--(?:output|remote-name)/;
const SAIDA_WGET = /^-[a-z]*o|^--output-document/;
const NAO_GRAVA = new Set(["-", "/dev/null", "nul", "null"]);
function baixarERodar(segs) {
  let gravou = false;
  const destinos = new Set();
  segs.forEach((s, i) => {
    const curl = s.tok.includes("curl"), wget = s.tok.includes("wget");
    s.tok.forEach((t, k) => {
      if (!((curl && SAIDA_CURL.test(t)) || (wget && SAIDA_WGET.test(t)) || t === "-outfile")) return;
      const colado = t.startsWith("--") ? t.split("=")[1] : t === "-outfile" ? "" : t.slice(t.indexOf("o", 1) + 1);
      const destino = colado || s.tok[k + 1];
      if (NAO_GRAVA.has(destino)) return;
      gravou = true;
      if (!colado) destinos.add(`${i}:${k + 1}`);
    });
    if (s.tok.some((t) => /\.downloadfile$/.test(t))) gravou = true;
  });
  if (!gravou) return null;
  const rodou = segs.some((s, i) => s.tok.some((t, k) => !destinos.has(`${i}:${k}`) && (FETCH_INTERP.has(t) || t === "pwsh" || t === "powershell" || t.startsWith("./"))));
  if (!rodou) return null;
  const todos = segs.flatMap((s) => s.tok);
  const u = todos.find(isUrl);
  return u ? { item: u, tipo: T.script, casa: false } : semNome(T.script, todos.join(" "));
}

/** todos os hits do comando (N ∪ N2; detectar só cresce com texto a mais) */
export function commandItems(command, { cwd = process.cwd() } = {}) {
  if (typeof command !== "string" || !command.trim()) return [];
  const raw = split(command.replace(/\\\r?\n/g, " "));
  const hits = [];
  const seen = new Set();
  const add = (x) => {
    const k = `${x.item}\u0000${x.tipo}\u0000${x.casa}`;
    if (!seen.has(k)) {
      seen.add(k);
      hits.push(x);
    }
  };
  for (const norm of [N, N2]) {
    const segs = raw.map((s) => ({ ...s, tok: norm(s.text).split(/\s+/).filter(Boolean) }));
    for (let i = 0; i < segs.length; i++) {
      for (const x of detectSeg(segs[i].tok, segs[i].text, { cwd })) add(x);
      for (const alvo of escreveProtegido(segs[i].tok)) add({ item: alvo, tipo: T.file, casa: false });
      // pipe pra interpretador: trecho depois de um | que começa (depois de prefixos, flags e VAR=) com sh/bash/iex/node/python…
      if (segs[i].pipeFromPrev && i > 0) {
        const t = segs[i].tok;
        // o interpretador pode vir depois de prefixos, flags, VAR= e do valor de uma flag (sudo -u root bash): em cada posição
        // olha se já é o interpretador; senão, só segue se for prefixo/flag/VAR=/número ou a palavra logo depois de uma flag
        let k = 0;
        while (k < t.length && !INTERP.has(t[k])) {
          const ok = PREFIX.has(t[k]) || isFlag(t[k]) || /^[a-z_][a-z0-9_]*=/.test(t[k]) || /^\d+[smh]?$/.test(t[k]) || (k > 0 && isFlag(t[k - 1]));
          if (!ok) break;
          k++;
        }
        if (k < t.length && INTERP.has(t[k])) {
          // o que alimenta o pipe: o 1º trecho da cadeia de | até aqui
          let j = i - 1;
          while (j > 0 && segs[j].pipeFromPrev) j--;
          const feed = segs.slice(j, i).map((s) => s.tok.join(" ")).join(" | ");
          const u = segs.slice(j, i).flatMap((s) => s.tok).find(isUrl);
          add(u ? { item: u, tipo: T.script, casa: false } : semNome(T.script, feed));
        }
      }
    }
    const b = baixarERodar(segs);
    if (b) add(b);
  }
  return hits;
}

// ─── arquivos que viram skill, agente ou conector ───────────────────────

const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/(\.\/)+/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
export function fileItem(filePath, home = homedir()) {
  if (typeof filePath !== "string" || !filePath) return null;
  const h = norm(home);
  const p = norm(filePath.replace(/^~(?=[\\/])/, home));
  const low = p.toLowerCase();
  const inside = ["skills", "agents", "commands", "plugins"].some((d) => low.startsWith(`${h.toLowerCase()}/.claude/${d}/`));
  const exact = low === `${h.toLowerCase()}/.claude.json` || /(^|\/)\.mcp\.json$/.test(low) || /(^|\/)\.claude\/settings(\.local)?\.json$/.test(low);
  if (!inside && !exact) return null;
  return { item: p.startsWith(h + "/") ? "~" + p.slice(h.length) : p, tipo: T.file, casa: false };
}

// ─── a pasta e a chave do porteiro são do aluno ─────────────────────────

export const MOTIVO_PASTA =
  "[porteiro] Esse comando mexe no porteiro (a pasta ~/.iron/porteiro, onde ficam o que o aluno liberou e o modo do porteiro). A liberação é do aluno, não do Iron: não toque nisso. Pra instalar algo de fora, rode o comando de instalação e siga a pergunta do porteiro.";

// Gate r9 (Filipe): uma regra só, por presença. Barra quando o texto cita o CAMINHO .iron/porteiro (fim do nome em
// qualquer coisa que não seja letra ou número), ou o nome liberados.json, ou porteiro/modo, ou cita .iron E a palavra
// porteiro no mesmo comando (cd ~/.iron && rm -rf porteiro), ou roda com a pasta atual dentro de ~/.iron e cita porteiro.
// A palavra porteiro sozinha não barra (git commit -m "porteiro pronto"). A checagem roda no texto ANTES de reduzir
// caminho a nome base (senão `cd ~/.iron/porteiro` viraria só "porteiro"); leitura sem barra invertida ∪ com ela virando "/".
const PASTA_RE = /\.iron\/porteiro(?![a-z0-9])|liberados\.json|porteiro\/modo/;
const brutos = (txt) => {
  // gate r9: `\⏎` no shell junta as pontas (p\⏎orteiro = porteiro); lê com espaço E colado (só acrescenta leitura)
  const bases = [String(txt).replace(/\\\r?\n/g, " "), String(txt).replace(/\\\r?\n/g, "")];
  return bases.flatMap((base) => [base.replace(/\\/g, ""), base.replace(/\\/g, "/")]).flatMap((t) => {
    const l = t.replace(/["'`]/g, "").replace(/\$\(|\$\{|<\(|>\(|[$(){}]/g, " ").toLowerCase();
    return [l, l.replace(/\/(\.\/)+/g, "/").replace(/\/{2,}/g, "/")];
  });
};
function tocaPorteiro(tool, input, home, cwd) {
  let txt;
  if (tool === "Bash" || tool === "PowerShell") txt = typeof input.command === "string" ? input.command : "";
  else txt = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : "";
  const ls = brutos(txt);
  if (ls.some((t) => PASTA_RE.test(t) || (/\.iron(?![a-z0-9_-])/.test(t) && /porteiro/.test(t)))) return true;
  const c = norm(cwd).toLowerCase(), h = norm(home).toLowerCase();
  return (c === `${h}/.iron` || c.startsWith(`${h}/.iron/`)) && ls.some((t) => /porteiro/.test(t));
}

// ─── decisão ────────────────────────────────────────────────────────────

function liberados(home) {
  try {
    const arr = JSON.parse(readFileSync(join(home, ".iron", "porteiro", "liberados.json"), "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// o Iron vê o item já sem segredo; o hash é do que ele vê (o servidor confere o texto do ask contra esse hash)
const shown = (item) => redactKeys(item, 2000).text;

export function motivo(item, tipo) {
  const vis = shown(item);
  const h = hashOf(vis);
  return (
    `[porteiro] "${vis}" (${tipo}) não é da casa e o aluno ainda não liberou. NÃO rode de novo nem procure outro caminho de instalação. ` +
    `Faça UMA pergunta pelo ask: question exatamente "${porteiroPergunta(vis, tipo)}" ` +
    `options exatamente [{"id":"pt-estudar-${h}","label":"${PORTEIRO_ROTULOS.estudar}"},{"id":"pt-instalar-${h}","label":"${PORTEIRO_ROTULOS.instalar}"},{"id":"pt-nao-${h}","label":"${PORTEIRO_ROTULOS.nao}"}]. ` +
    `Estudar antes → carregue a skill estudar-instalacao. Só depois de "${PORTEIRO_ROTULOS.instalar}" o mesmo comando passa (30 minutos). Não instalar → siga sem ele.`
  );
}

/** Decide um evento do gancho. Devolve null (passa calado), { pass, registro } ou { reason, registro } (barra). */
export function decide(hook, { home = homedir(), now = Date.now() } = {}) {
  if (!hook || typeof hook !== "object") return null;
  const tool = hook.tool_name;
  const input = hook.tool_input && typeof hook.tool_input === "object" ? hook.tool_input : {};
  const cwd = typeof hook.cwd === "string" && hook.cwd ? hook.cwd : process.cwd();
  const ehComando = tool === "Bash" || tool === "PowerShell";
  const ehArquivo = ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool);
  if (!ehComando && !ehArquivo) return null;
  if (tocaPorteiro(tool, input, home, cwd)) return { reason: MOTIVO_PASTA, registro: { item: "porteiro", tipo: "pasta ou chave do porteiro" } };

  let items = [];
  if (ehComando) items = commandItems(typeof input.command === "string" ? input.command : "", { cwd });
  else {
    const f = fileItem(typeof input.file_path === "string" ? input.file_path : input.notebook_path, home);
    if (f) items = [f];
  }
  const fora = items.filter((x) => x.item && !x.casa);
  if (!fora.length) return null;
  const ok = new Set(liberados(home).filter((l) => l && typeof l.hash === "string" && Number(l.until) > now).map((l) => l.hash));
  const barrado = fora.find((x) => !ok.has(hashOf(shown(x.item))));
  if (!barrado) return { pass: true, registro: fora.map((x) => ({ item: x.item, tipo: x.tipo, decisao: "liberado" })) };
  return { reason: motivo(barrado.item, barrado.tipo), registro: { item: barrado.item, tipo: barrado.tipo } };
}

function registra(home, linhas) {
  try {
    const dir = join(home, ".iron", "porteiro");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const at = new Date().toISOString();
    const txt = linhas.map((l) => JSON.stringify({ at, item: redactKeys(l.item, 300).text, tipo: l.tipo, decisao: l.decisao })).join("\n") + "\n";
    appendFileSync(join(dir, "registro.jsonl"), txt, { mode: 0o600 });
  } catch {
    // registro é ajuda, não condição
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

async function main() {
  const home = homedir();
  const mode = porteiroMode(home);
  if (mode === "off") return;
  if (mode === "canal" && process.env.IRON_OFFICE_CHANNEL !== "1") return;
  let hook;
  try {
    hook = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const d = decide(hook, { home });
  if (!d) return;
  if (d.pass) return registra(home, d.registro);
  registra(home, [{ ...d.registro, decisao: "barrado" }]);
  const reason = redactKeys(d.reason, 3000).text;
  const out = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
  // no macOS o stdout num pipe é assíncrono: espera escrever antes do exit (senão o JSON sai cortado e o comando passa)
  await new Promise((r) => process.stdout.write(out, () => r()));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
}
