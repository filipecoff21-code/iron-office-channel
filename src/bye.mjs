// Iron Office: despedida solta (0.3.8). O servidor do canal cria este processo `detached` ao fechar:
// quando a janela do terminal fecha, o grupo de processos inteiro morre (o servidor junto), mas este
// filho, fora do grupo, termina o POST e o escritório anoitece na hora.
// Uso: node bye.mjs <base> <session_id> [espera_ms]. A chave é lida do arquivo, NUNCA por argumento
// (apareceria no `ps`). Sai 0 sempre; nunca imprime a chave. `espera_ms` (até 1000): o servidor manda
// 400 quando há batimento em voo, pro bye chegar depois dele.
// Teste: com NODE_ENV=test e IRON_OFFICE_BYE_SPY=<arquivo>, grava uma linha JSON nesse arquivo em vez
// de chamar a rede.
import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const KEY_PATH = join(homedir(), ".claude", "iron-office-api-key");

// mesma leitura do server.mjs (o `echo` do PowerShell grava UTF-16 com BOM)
function readKey() {
  try {
    const buf = readFileSync(KEY_PATH);
    const utf16 = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
    return buf
      .toString(utf16 ? "utf16le" : "utf8")
      .replace(/[﻿\u0000]/g, "")
      .trim();
  } catch {
    return "";
  }
}

const [base, sessionId, wait] = process.argv.slice(2);
const spy = process.env.NODE_ENV === "test" ? process.env.IRON_OFFICE_BYE_SPY : "";
const waitMs = Math.min(1000, Math.max(0, Number(wait) || 0));

try {
  if (spy) {
    appendFileSync(spy, JSON.stringify({ base, session_id: sessionId, argv: process.argv.slice(2), has_key: !!readKey() }) + "\n");
  } else {
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
    const key = readKey();
    if (base && key) {
      await fetch(`${base.replace(/\/+$/, "")}/api/chat/presence`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify({ bye: true, session_id: sessionId || null }),
        signal: AbortSignal.timeout(2500),
      });
    }
  }
} catch {
  // site fora ou lento: a noite cai pelo batimento (60 s), como antes da 0.3.7
}
process.exit(0);
