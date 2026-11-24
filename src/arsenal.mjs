// 0.33.0 (onda 16): o "Seu Iron" medido no computador do aluno.
// Conta os agentes (~/.claude/agents/*.md), os especialistas dos squads (~/.iron/squad-*/agents/*.md, o IRON_DIR do
// instalador) e as skills (~/.claude/skills/*/SKILL.md). Sai SÓ número + os ids que existem no manifesto do Iron
// (~/.iron/manifest.json, copiado pelo instalador 2.42.0): agente, skill ou squad próprio do aluno entra no número e
// NUNCA com o nome (pode ser de cliente). Junto vai o mapa de departamentos do pacote instalado, pro site não depender
// do deploy dele. Erro de leitura vira número parcial com `partial: true`; nada aqui lança exceção.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function list(dir) {
  try {
    return { ok: true, items: readdirSync(dir, { withFileTypes: true }) };
  } catch (e) {
    return { ok: e?.code === "ENOENT", items: [] }; // pasta ausente = 0 (não é erro); sem permissão = parcial
  }
}

// gate r1: symlink quebrado não conta (statSync segue o link; alvo ausente = fora)
function isFileAt(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

function readManifest(ironDir) {
  try {
    const m = JSON.parse(readFileSync(join(ironDir, "manifest.json"), "utf8"));
    return m && typeof m === "object" ? m : null;
  } catch {
    return null;
  }
}

/** Fotografa o arsenal. `home` é injetável pro teste (árvore falsa em pasta temporária). */
export function arsenalSnapshot(home) {
  const claude = join(home, ".claude");
  const ironDir = join(home, ".iron");
  let partial = false;
  const man = readManifest(ironDir);
  if (!man) partial = true; // ~/.iron ausente, Iron antigo (sem manifest.json) ou arquivo quebrado
  const knownAgents = new Set((Array.isArray(man?.agents_top) ? man.agents_top : []).map((a) => a?.id).filter((id) => typeof id === "string"));
  const knownSkills = new Set((Array.isArray(man?.skills) ? man.skills : []).map((s) => s?.id).filter((id) => typeof id === "string"));
  const knownSquads = new Set(man?.squads && typeof man.squads === "object" ? Object.keys(man.squads) : []);

  const ag = list(join(claude, "agents"));
  if (!ag.ok) partial = true;
  const agentIds = ag.items.filter((e) => e.name.endsWith(".md") && (e.isFile() || (e.isSymbolicLink() && isFileAt(join(claude, "agents", e.name))))).map((e) => e.name.slice(0, -3));

  const sk = list(join(claude, "skills"));
  if (!sk.ok) partial = true;
  const skillIds = sk.items.filter((e) => (e.isDirectory() || e.isSymbolicLink()) && existsSync(join(claude, "skills", e.name, "SKILL.md"))).map((e) => e.name);

  const ir = list(ironDir);
  if (!ir.ok) partial = true;
  let specialists = 0;
  const bySquad = {};
  for (const e of ir.items) {
    if (!(e.isDirectory() || e.isSymbolicLink()) || !e.name.startsWith("squad-")) continue;
    const sa = list(join(ironDir, e.name, "agents"));
    if (!sa.ok) partial = true;
    const n = sa.items.filter((x) => x.name.endsWith(".md") && (x.isFile() || (x.isSymbolicLink() && isFileAt(join(ironDir, e.name, "agents", x.name))))).length;
    specialists += n;
    if (knownSquads.has(e.name)) bySquad[e.name] = n; // squad fora do manifesto: só no número
  }

  const ironIds = [...new Set([...agentIds.filter((id) => knownAgents.has(id)), ...skillIds.filter((id) => knownSkills.has(id))])]
    .filter((id) => ID_RE.test(id)).sort();
  const deps = man?.departments && typeof man.departments === "object" ? man.departments : null;
  const body = {
    agents: agentIds.length,
    specialists,
    skills: skillIds.length,
    squads: Object.keys(bySquad).length,
    iron_ids: ironIds,
    by_squad: Object.fromEntries(Object.entries(bySquad).sort(([a], [b]) => a.localeCompare(b))),
    ...(deps ? { departments: deps } : {}),
    pkg_version: typeof man?.version === "string" ? man.version.slice(0, 20) : null,
    partial,
  };
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return { ...body, hash };
}
