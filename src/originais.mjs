// 0.29.0 (onda 59): onde o `image_get` grava o arquivo original da imagem escolhida. Módulo à parte do server.mjs
// (o teste importa sem subir o servidor). Nenhum texto do pedido entra no caminho: o id é UUID validado, o nome da
// loja vira a-z0-9- e o tipo é de lista fechada; no fim, confere que o arquivo ficou dentro da base.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// O cofre do aluno: a MESMA regra do instalador (iron-edge-cli installer/office.js, campoYaml + resolveCwd, onda 26b):
// vault_path → obsidian_vault_path → obsidian.vault_path; `~` (com / ou \) e caminho relativo contam a partir da HOME;
// pasta que não existe = sem cofre (nunca cria um cofre fantasma); aponta pra dentro do cofre = sobe até a .obsidian.
function campoYaml(txt, nome, bloco) {
  const linhas = String(txt || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  let dentro = !bloco;
  for (const l of linhas) {
    if (/^\s*(#|$)/.test(l)) continue;
    if (bloco) {
      if (/^\S/.test(l)) { dentro = new RegExp("^" + bloco + ":\\s*(#.*)?$").test(l); continue; }
      if (!dentro) continue;
    } else if (/^\s/.test(l)) continue;
    const m = l.match(new RegExp("^\\s*" + nome + ":\\s*(.*)$"));
    if (!m) continue;
    const v = m[1].trim();
    if (v.startsWith('"')) { const q = v.match(/^"((?:[^"\\]|\\.)*)"/); return q ? q[1].replace(/\\(["\\])/g, "$1") : ""; }
    if (v.startsWith("'")) { const q = v.match(/^'((?:[^']|'')*)'/); return q ? q[1].replace(/''/g, "'") : ""; }
    return v.replace(/\s+#.*$/, "").trim();
  }
  return "";
}
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
export function cofreDir(home = homedir()) {
  let txt = "";
  try { txt = readFileSync(join(home, ".iron", "config.yaml"), "utf8"); } catch { return null; }
  const str = (v) => (typeof v === "string" && v.trim() && !/^(~|null)$/i.test(v.trim()) ? v.trim() : "");
  const raw = str(campoYaml(txt, "vault_path")) || str(campoYaml(txt, "obsidian_vault_path")) || str(campoYaml(txt, "vault_path", "obsidian"));
  if (!raw) return null;
  const abs = resolve(home, raw.replace(/^~(?=$|[\\/])/, home));
  if (!isDir(abs)) return null;
  let d = abs;
  for (let i = 0; i < 6; i++) {
    if (isDir(join(d, ".obsidian"))) return d;
    const up = dirname(d);
    if (up === d || relative(home, up).startsWith("..") || up === home) break;
    d = up;
  }
  return abs;
}
// nome de pasta da loja: só a-z, 0-9 e hífen (nada do nome entra cru no caminho: "../" vira "")
export function slugLoja(store) {
  const base = String(store?.slug || store?.name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return base || "loja";
}
// pasta FIXA: <cofre>/Projetos/<loja>/marca/originais (sem cofre, ~/Iron Office/<loja>/marca/originais).
// O nome do arquivo é <8 do id>.<ext>; id já validado como UUID e ext de lista fechada. Confere que ficou dentro da base.
export function originalPath({ home = homedir(), cofre = cofreDir(home), store, imageId, kind }) {
  if (!UUID_RE.test(imageId)) throw new Error("image_id inválido");
  const ext = kind === "alpha" ? "-sem-fundo.png" : kind === "original-png" ? ".png" : ".jpg";
  const base = cofre ? resolve(cofre, "Projetos") : resolve(home, "Iron Office");
  const dir = resolve(base, slugLoja(store), "marca", "originais");
  const file = resolve(dir, imageId.slice(0, 8).toLowerCase() + ext);
  if (!file.startsWith(base + sep)) throw new Error("caminho fora da pasta da loja");
  return { dir, file };
}
