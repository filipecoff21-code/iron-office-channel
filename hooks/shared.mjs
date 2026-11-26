// Iron Office — partes comuns ao hook de telemetria e ao servidor do canal (0.5.0):
// os padrões de segredo apagados de todo texto que sai, e a chave `office_feed` do ~/.iron/config.yaml.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// Padrões de segredo apagados de todo texto que sai
export const SECRET_PATTERNS = [
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
  /["']?\b[\w-]{0,40}(?:key|token|secret|password|passwd|pwd|pass)[\w-]{0,40}\b["']?\s*:\s*["'][^"']{0,500}["']/gi, // "campo": "valor" (JSON/YAML); nomes limitados (sem custo quadrático)
  /--?(?:password|passwd|pass|token|secret|api-?key|auth|access-token)(?:[=\s]+)\S+/gi, // --password X, --token=X
  /(\s-p)(?!\s)\S+/g, // mysql -pSENHA (grudado; `mkdir -p x` não casa)
  /(\s-u\s+)[^\s:]+:\S+/g, // curl -u usuario:senha
  /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD)[A-Z0-9_]*)\s*[=:]\s*\S+/gi,
  /:\/\/[^\s/:@]+:[^\s/@]+@/g, // usuário:senha em URL
];

// Só formatos de chave (0.5.0, deliver e reply): o texto longo de uma entrega tem "Key:", "Pass:", " -pra"
// legítimos que os padrões genéricos de campo estragariam. Mais o par NOME_EM_MAIUSCULA=valor de um .env colado.
export const KEY_FORMAT_PATTERNS = [
  ...SECRET_PATTERNS.slice(0, 11),
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bhf_[A-Za-z0-9]{20,}/g, // Hugging Face
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}/g, // Supabase (chaves novas)
  /:\/\/[^\s/:@]+:[^\s/@]+@/g, // usuário:senha em URL
  /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD)[A-Z0-9_]*)=\S+/g, // .env: NOME=valor (com ou sem prefixo, MAIÚSCULO)
  /\b(password|passwd|pwd|secret|token|api_?key|access_?token|client_?secret)=\S+/gi, // os mesmos nomes comuns em minúscula
]

// Entrega e resposta do canal: limita ANTES de filtrar (o filtro nunca roda em texto sem teto), filtra só
// formatos de chave e corta por caractere (code point): emoji no ponto de corte não vira metade solta.
export function redactKeys(s, max) {
  const chars = Array.from(String(s ?? ""));
  const capped = chars.length > max + 1000 ? chars.slice(0, max + 1000).join("") : chars.join("");
  let out = capped;
  for (const re of KEY_FORMAT_PATTERNS) {
    out = out.replace(re, (m, g1) => (typeof g1 === "string" && /=/.test(m) ? `${g1}=[redigido]` : "[redigido]"));
  }
  const final = Array.from(out);
  return final.length > max ? { text: final.slice(0, max).join(""), cut: true } : { text: out, cut: false };
}

export function redact(s) {
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


// Feed do escritório (0.5.0): `office_feed: off` no ~/.iron/config.yaml desliga o que o hook manda e tira a
// pasta e os conectores da presença. Desliga com off/false/no/0 em qualquer caixa (o aluno pode editar à mão),
// ignora o BOM do Bloco de Notas e, como no YAML, a última ocorrência da chave vale. Sem arquivo, sem a chave
// ou com valor desconhecido: ligado (padrão).
export function feedOn(home = homedir()) {
  let txt;
  try {
    txt = readFileSync(join(home, ".iron", "config.yaml"), "utf8").replace(/^\uFEFF/, "");
  } catch {
    return true;
  }
  const all = [...txt.matchAll(/^office_feed:[ \t]*["']?([A-Za-z0-9]+)["']?[ \t]*(?:#.*)?\r?$/gm)];
  if (!all.length) return true;
  return !["off", "false", "no", "0"].includes(all[all.length - 1][1].toLowerCase());
}

// Porteiro de instalação (0.22.0): o modo fica em ~/.iron/porteiro/modo (dentro da pasta que o Iron não pode tocar;
// gate r9: saiu do config.yaml, que a loja e o salvar gravam). "todas" liga em toda sessão do Claude Code, "off" desliga;
// sem arquivo ou com outro valor: "canal" (só a sessão do ironoffice). Lê a primeira palavra (BOM, aspas e comentário aceitos).
export function porteiroMode(home = homedir()) {
  let txt;
  try {
    txt = readFileSync(join(home, ".iron", "porteiro", "modo"), "utf8").replace(/^\uFEFF/, "");
  } catch {
    return "canal";
  }
  const m = /^[ \t]*["']?([A-Za-z0-9]+)["']?[ \t]*(?:#.*)?$/m.exec(txt.replace(/\r/g, ""));
  const v = m ? m[1].toLowerCase() : "";
  if (v === "todas") return "todas";
  if (["off", "false", "no", "0"].includes(v)) return "off";
  return "canal";
}

// ─── Porteiro: o que o gancho (hooks/porteiro.mjs) e o servidor (o clique e o ask) precisam combinar ───
// Hash de 12 hex (48 bits; gate 54 r1: 8 hex dava colisão buscável): "pt-instalar-" (12) + 12 = 24, o máximo do id de opção.
export const porteiroHash = (item) => createHash("sha1").update(String(item)).digest("hex").slice(0, 12);
export const PORTEIRO_ID_RE = /^pt-(estudar|instalar|nao)-([a-f0-9]{12})$/;
export const PORTEIRO_ROTULOS = { estudar: "Estudar antes (recomendado)", instalar: "Instalar mesmo assim", nao: "Não instalar" };
// tipos sem jargão (o texto da pergunta é conferido pelo servidor). Revisão 1: quando o porteiro detecta mas não
// consegue ler o nome, o item é o trecho do comando e o tipo ganha "; não consegui ler o nome".
const TIPOS_BASE = [
  "pacote npm", "pacote executado", "pacote Python", "pacote de um link", "pacote de uma pasta", "programa do Homebrew",
  "repositório git", "script baixado ou gerado", "conector do Claude", "plugin do Claude Code", "loja de plugins",
  "extensão do VS Code", "arquivo que dá ordens ao Iron",
];
export const PORTEIRO_SEM_NOME = "; não consegui ler o nome";
export const PORTEIRO_TIPOS = TIPOS_BASE.flatMap((t) => [t, t + PORTEIRO_SEM_NOME]);
// 0.29.0 (onda 59): o nome do item na PERGUNTA vai até 120 caracteres (a pergunta inteira tem que caber nos 300 do chat;
// um link comprido de download estourava e o aluno nem via a pergunta). O id continua sendo o hash do item INTEIRO:
// liberar vale pro item inteiro, nunca pra tudo que começa igual. O gancho registra hash + nome cortado pra conferência.
export const PORTEIRO_ITEM_MAX = 120;
export const porteiroItemCurto = (item) => {
  const s = String(item);
  // gate 59 r1: o teto do chat conta unidades UTF-16 (emoji = 2); corta por caractere sem passar de 120 unidades
  if (s.length <= PORTEIRO_ITEM_MAX) return s;
  let out = "";
  for (const ch of s) { if (out.length + ch.length > PORTEIRO_ITEM_MAX - 1) break; out += ch; }
  return out + "…";
};
export const porteiroPergunta = (item, tipo) => `O Iron quer instalar ${item} (${tipo}). Nada de fora entra no seu computador sem você decidir.`;
export const porteiroPerguntaEstudo = (item) => `Depois do estudo: instalo ${item}?`;

// gate 54 r1: o Iron escreve o texto e os ids do ask; sem esta conferência ele podia perguntar sobre uma coisa e mandar o id
// de outra. Devolve null (não é pergunta do porteiro), { ok: true } ou { ok: false, error }.
function cortadoRegistrado(home, hash, curto) {
  let linhas;
  try { linhas = readFileSync(join(home, ".iron", "porteiro", "registro.jsonl"), "utf8").split("\n").slice(-300); } catch { return false; }
  for (const l of linhas) {
    try { const r = JSON.parse(l); if (r?.decisao === "barrado" && r.hash === hash && r.curto === curto) return true; } catch {}
  }
  return false;
}

export function porteiroAskCheck(text, options, { home = homedir() } = {}) {
  const opts = Array.isArray(options) ? options : [];
  if (!opts.some((o) => typeof o?.id === "string" && o.id.startsWith("pt-"))) return null;
  const erro = (e) => ({ ok: false, error: `Pergunta do porteiro fora do modelo: ${e}. Use exatamente o texto e as opções que o motivo do porteiro mandou.` });
  let hash = null;
  for (const o of opts) {
    const m = typeof o?.id === "string" ? PORTEIRO_ID_RE.exec(o.id) : null;
    if (!m) return erro(`a opção "${o?.label ?? ""}" não é do porteiro`);
    if (hash && m[2] !== hash) return erro("as opções apontam pra itens diferentes");
    hash = m[2];
    if (o.label !== PORTEIRO_ROTULOS[m[1]]) return erro(`o rótulo do id ${o.id} tem que ser "${PORTEIRO_ROTULOS[m[1]]}"`);
  }
  const t = String(text ?? "");
  let item = null;
  for (const tipo of PORTEIRO_TIPOS) {
    const pre = "O Iron quer instalar ";
    const suf = ` (${tipo}). Nada de fora entra no seu computador sem você decidir.`;
    if (t.startsWith(pre) && t.endsWith(suf) && t.length > pre.length + suf.length) item = t.slice(pre.length, t.length - suf.length);
  }
  if (item === null && t.startsWith("Depois do estudo: instalo ") && t.endsWith("?")) item = t.slice("Depois do estudo: instalo ".length, -1);
  if (!item) return erro("o texto da pergunta mudou");
  if (porteiroHash(item) === hash) return { ok: true };
  // nome cortado (onda 59): vale só se o GANCHO barrou um item com esse hash e esse mesmo nome cortado
  if (item.endsWith("…") && cortadoRegistrado(home, hash, item)) return { ok: true };
  return erro(`o item "${item}" não é o do id`);
}

// ─── Onda S3 (0.36.0): arquivos de segredo no computador do aluno ───────────────────────────────────────────────────
// TRANCADOS: a chave do Iron Office (e a anterior), o ~/.claude.json e o ~/.claude/.credentials.json. O Iron nunca abre,
// sem pergunta e sem liberação possível (a pasta ~/.iron/porteiro já era barrada pelo porteiro de instalação).
// ARQUIVO DE SENHAS: nome `.env` ou `.env.<algo>` em qualquer pasta, menos os modelos .env.example/.sample/.template.
// Abre só depois do clique do aluno numa pergunta calma (ids ev-ler-<hash>/ev-nao-<hash>, hash = porteiroHash do caminho
// absoluto normalizado). Quem libera é o plugin (src/server.mjs), 30 minutos, só aquele caminho.
export const ENV_ID_RE = /^ev-(ler|nao)-([a-f0-9]{12})$/;
export const ENV_ROTULOS = { ler: "Sim, pode abrir", nao: "Não" };
export const ENV_LIBERA_MS = 30 * 60_000;
const ENV_MODELOS = new Set(["example", "sample", "template"]);

/** Caminho absoluto normalizado: ~ e $HOME expandidos, barra invertida vira barra, sem ./ nem //, `..` resolvido,
 *  sem barra no fim; minúsculas no Windows (o disco de lá não diferencia). */
export function segNorm(p, { home = homedir(), cwd = process.cwd(), platform = process.platform } = {}) {
  const h = String(home).replace(/\\/g, "/").replace(/\/+$/, "");
  let s = String(p ?? "").replace(/\\/g, "/");
  s = s.replace(/^~(?=\/|$)/, h).replace(/^\$\{?HOME\}?(?=\/|$)/, h).replace(/^%USERPROFILE%(?=\/|$)/i, h).replace(/^\$env:USERPROFILE(?=\/|$)/i, h);
  const abs = /^\//.test(s) || /^[A-Za-z]:\//.test(s);
  if (!abs) s = String(cwd).replace(/\\/g, "/").replace(/\/+$/, "") + "/" + s;
  const drive = /^[A-Za-z]:/.exec(s)?.[0] ?? "";
  const partes = [];
  for (const parte of s.slice(drive.length).split("/")) {
    if (!parte || parte === ".") continue;
    if (parte === "..") partes.pop();
    else partes.push(parte);
  }
  const out = drive + "/" + partes.join("/");
  return platform === "win32" ? out.toLowerCase() : out;
}

const baseName = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop();

/** Arquivo de senhas (P2): `.env` ou `.env.<algo>`; os 3 modelos passam livres. */
export function ehArquivoDeSenhas(p) {
  const b = baseName(p).toLowerCase();
  if (b === ".env") return true;
  const m = /^\.env\.(.+)$/.exec(b);
  // gate S3 r1: modelo é o que TERMINA em .example/.sample/.template (.env.local.example também)
  return !!m && !ENV_MODELOS.has(m[1].split(".").pop());
}

/** Trancado (P1): devolve "chave" (chave do Iron Office), "conta" (~/.claude.json, credenciais) ou null. */
export function trancado(p, opts = {}) {
  const n = segNorm(p, opts);
  const h = segNorm(opts.home ?? homedir(), { ...opts, cwd: "/" });
  const low = n.toLowerCase(), hl = h.toLowerCase();
  if (low === `${hl}/.claude/iron-office-api-key` || low === `${hl}/.claude/iron-office-api-key.anterior`) return "chave";
  if (low === `${hl}/.claude.json` || low === `${hl}/.claude/.credentials.json`) return "conta";
  return null;
}

export const MOTIVO_TRANCADO = {
  chave: "[porteiro] Esse arquivo guarda a chave do Iron Office e o Iron não abre. Se o aluno precisa dela, ele gera outra em ironoffice.app. Não há liberação: não tente por outro caminho e não pergunte ao aluno.",
  conta: "[porteiro] Esse arquivo guarda a conta e os conectores do Claude e o Iron não abre. Não há liberação: não tente por outro caminho e não pergunte ao aluno. Pra ver os conectores, use a ferramenta status do plugin.",
};

// a pasta aparece com ~ quando está na home; caminho longo demais pro chat (300) vira "…/<últimas pastas>" e o servidor
// confere pelo registro do gancho (o mesmo jeito do nome cortado do porteiro, onda 59)
const ENV_PRE = "O Iron quer abrir o arquivo ";
const ENV_SUF = ". Esse tipo de arquivo costuma guardar senhas de outros sistemas. Foi você que pediu algo que precisa dele?";
const ENV_MEIO_MAX = 300 - ENV_PRE.length - ENV_SUF.length;
const ENV_PASTA_SEP = " da pasta ";
function pastaVisivel(dir, home) {
  const h = String(home).replace(/\\/g, "/").replace(/\/+$/, "");
  // gate S3 r1: só com a caixa exata (no macOS /TMP e /tmp são a mesma pasta, mas o hash é do texto: ~ esconderia a diferença)
  if (dir === h) return "~";
  return dir.startsWith(h + "/") ? "~" + dir.slice(h.length) : dir;
}
/** O meio da pergunta ("<nome> da pasta <pasta>") pro caminho já normalizado; cortado se não cabe. */
export function envMeio(caminhoNorm, { home = homedir() } = {}) {
  const i = caminhoNorm.lastIndexOf("/");
  const nome = caminhoNorm.slice(i + 1);
  const dir = caminhoNorm.slice(0, i) || "/";
  let pasta = pastaVisivel(dir, home);
  let meio = nome + ENV_PASTA_SEP + pasta;
  if (meio.length <= ENV_MEIO_MAX) return meio;
  const partes = pasta.split("/");
  while (partes.length > 1 && ("…/" + partes.join("/")).length + nome.length + ENV_PASTA_SEP.length > ENV_MEIO_MAX) partes.shift();
  pasta = "…/" + partes.join("/");
  meio = nome + ENV_PASTA_SEP + pasta;
  return meio.length <= ENV_MEIO_MAX ? meio : meio.slice(0, ENV_MEIO_MAX - 1) + "…";
}
export const envPergunta = (caminhoNorm, opts = {}) => ENV_PRE + envMeio(caminhoNorm, opts) + ENV_SUF;
export const envHash = (caminhoNorm) => porteiroHash(caminhoNorm);

export function motivoEnv(caminhoNorm, opts = {}) {
  const h = envHash(caminhoNorm);
  return (
    `[porteiro] O arquivo ${envMeio(caminhoNorm, opts)} costuma guardar senhas e o aluno ainda não liberou. NÃO tente abrir por outro caminho. ` +
    `Faça UMA pergunta pelo ask, sem alarme: question exatamente "${envPergunta(caminhoNorm, opts)}" ` +
    `options exatamente [{"id":"ev-ler-${h}","label":"${ENV_ROTULOS.ler}"},{"id":"ev-nao-${h}","label":"${ENV_ROTULOS.nao}"}]. ` +
    `Só depois de "${ENV_ROTULOS.ler}" o arquivo abre (30 minutos, só ele). "${ENV_ROTULOS.nao}" → siga sem o arquivo e não pergunte de novo. ` +
    `Mesmo aberto, o conteúdo dele nunca vai pro reply, pro deliver nem pro page_save.`
  );
}

/** Confere o ask com ids ev-: null (não é pergunta de .env), { ok: true } ou { ok: false, error }. */
export function envAskCheck(text, options, { home = homedir(), platform = process.platform } = {}) {
  const opts = Array.isArray(options) ? options : [];
  if (!opts.some((o) => typeof o?.id === "string" && o.id.startsWith("ev-"))) return null;
  const erro = (e) => ({ ok: false, error: `Pergunta do arquivo de senhas fora do modelo: ${e}. Use exatamente o texto e as opções que o motivo do porteiro mandou.` });
  let hash = null;
  for (const o of opts) {
    const m = typeof o?.id === "string" ? ENV_ID_RE.exec(o.id) : null;
    if (!m) return erro(`a opção "${o?.label ?? ""}" não é do arquivo de senhas`);
    if (hash && m[2] !== hash) return erro("as opções apontam pra arquivos diferentes");
    hash = m[2];
    if (o.label !== ENV_ROTULOS[m[1]]) return erro(`o rótulo do id ${o.id} tem que ser "${ENV_ROTULOS[m[1]]}"`);
  }
  const t = String(text ?? "");
  if (!t.startsWith(ENV_PRE) || !t.endsWith(ENV_SUF) || t.length <= ENV_PRE.length + ENV_SUF.length) return erro("o texto da pergunta mudou");
  const meio = t.slice(ENV_PRE.length, t.length - ENV_SUF.length);
  // o nome do arquivo pode ter " da pasta " dentro: tenta cada ponto de corte
  for (let i = meio.indexOf(ENV_PASTA_SEP); i > 0; i = meio.indexOf(ENV_PASTA_SEP, i + 1)) {
    const nome = meio.slice(0, i), pasta = meio.slice(i + ENV_PASTA_SEP.length);
    if (!ehArquivoDeSenhas(nome) || nome.includes("/")) continue;
    if (pasta.startsWith("…")) continue;
    const caminho = segNorm(pasta + "/" + nome, { home, cwd: "/", platform });
    if (envHash(caminho) === hash && envMeio(caminho, { home }) === meio) return { ok: true };
  }
  // caminho cortado: vale só se o GANCHO barrou esse hash com esse mesmo texto
  if (meio.includes("…") && cortadoRegistrado(home, hash, meio)) return { ok: true };
  return erro("o arquivo da pergunta não é o do id");
}

/** Liberação válida de .env pra esse caminho normalizado (lida do liberados.json do porteiro). tipo "env-nao" = o aluno
 *  clicou Não há menos de 30 min (gate S3 r1: sem isso o gancho mandava perguntar de novo e o servidor mandava não perguntar). */
export function envLiberado(caminhoNorm, { home = homedir(), now = Date.now(), tipo = "env" } = {}) {
  let arr;
  try { arr = JSON.parse(readFileSync(join(home, ".iron", "porteiro", "liberados.json"), "utf8")); } catch { return false; }
  if (!Array.isArray(arr)) return false;
  const h = envHash(caminhoNorm);
  return arr.some((l) => l && l.tipo === tipo && l.hash === h && Number(l.until) > now);
}
export const MOTIVO_ENV_RECUSADO = "[porteiro] O aluno disse Não pra abrir esse arquivo há pouco. Siga sem ele e não pergunte de novo agora.";
export const MOTIVO_ENV_CD =
  "[porteiro] Esse pedido muda de pasta (cd, pushd, -C) ou busca .env em qualquer subpasta, e aí não dá pra saber qual arquivo .env é. Rode de novo com o caminho completo do arquivo (ex.: ~/pasta/.env), sem cd no mesmo comando.";
export const MOTIVO_BUSCA =
  "[porteiro] Essa busca passa pela pasta ~/.claude, onde ficam a chave do Iron Office e a conta do Claude, e o Iron não lê essa pasta assim. Busque dentro da pasta do projeto. Não há liberação: não pergunte ao aluno.";
