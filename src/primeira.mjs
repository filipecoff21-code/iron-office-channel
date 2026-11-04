// Onda 49: em que pé está a primeira conversa do aluno, olhando só o cofre onde a sessão abriu.
// Nunca lança: erro de leitura é "nada" (a conversa segue sem linha nenhuma).
//   "nada": fora de um cofre (falta CLAUDE.md ou Projetos/), ou cofre já em uso sem 00 Sobre mim.md
//   "novo": cofre sem perfil, sem projeto e sem diário
//   "andamento": 00 Sobre mim.md com `entrevista: em_andamento` no cabeçalho
//   "ler": 00 Sobre mim.md em qualquer outro estado, inclusive sem cabeçalho
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SOBRE_MIM = "00 Sobre mim.md";

export function estadoPrimeira(cwd) {
  try {
    if (!existsSync(join(cwd, "CLAUDE.md"))) return "nada";
    const projetos = readdirSync(join(cwd, "Projetos"));
    const sobre = join(cwd, SOBRE_MIM);
    if (existsSync(sobre)) {
      // o Bloco de Notas do Windows grava BOM, e o aluno pode editar: BOM, linha em branco no começo e aspas não mudam o estado
      const cabecalho = /^\uFEFF?\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(sobre, "utf8"));
      return cabecalho && /^entrevista:\s*["']?em_andamento["']?\s*$/m.test(cabecalho[1]) ? "andamento" : "ler";
    }
    if (projetos.some((n) => !n.startsWith("."))) return "nada";
    return existsSync(join(cwd, "memoria", "historico.md")) ? "nada" : "novo";
  } catch {
    return "nada";
  }
}
