// Onda 55: a trava do canal (~/.iron/office.lock), fora do server.mjs pra corrida de duas aberturas ser testada de forma determinística.
// Trava órfã: quem conseguir RENOMEAR leva. Renomear é atômico (o segundo recebe ENOENT); e, se entre ler o dono e renomear outro
// processo já pegou a trava, o nome renomeado traz o pid dele: devolve o arquivo e a próxima volta lê o dono novo, vivo.
import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

const ler = (p) => {
  try {
    return parseInt(readFileSync(p, "utf8").trim(), 10);
  } catch {
    return NaN;
  }
};
const mesmo = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));

/** `antesDeTomar` só existe pro teste segurar um processo entre ver a trava órfã e tomá-la. */
export async function acquireLockFile({ path, pid, holderAlive, log = () => {}, antesDeTomar = async () => {} }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(pid), { flag: "wx" }); // atômico: falha se já existe
      return true;
    } catch (e) {
      if (!e || e.code !== "EEXIST") {
        log(`lock indisponível (${e?.message}); seguindo sem lock`);
        return true;
      }
    }
    let holder = ler(path);
    if (Number.isNaN(holder)) {
      // o `wx` cria o arquivo vazio e só depois grava o pid: espera e relê antes de chamar de órfão
      await new Promise((r) => setTimeout(r, 200));
      holder = ler(path);
    }
    if (holder === pid) return true;
    if (await holderAlive(holder)) return false;
    await antesDeTomar();
    const orfao = `${path}.orfao.${pid}`;
    try {
      renameSync(path, orfao);
    } catch {
      continue; // outro processo levou antes: a próxima volta lê o dono novo
    }
    if (!mesmo(ler(orfao), holder)) {
      try {
        linkSync(orfao, path); // era a trava nova de outro processo: devolve sem sobrescrever
      } catch {
        // já existe outra: ela vale
      }
    }
    try {
      unlinkSync(orfao);
    } catch {
      // nada
    }
  }
  return false;
}
