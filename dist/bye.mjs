import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const KEY_PATH = join(homedir(), ".claude", "iron-office-api-key");
function readKey() {
  try {
    const buf = readFileSync(KEY_PATH);
    const utf16 = buf.length >= 2 && buf[0] === 255 && buf[1] === 254;
    return buf.toString(utf16 ? "utf16le" : "utf8").replace(/[﻿\u0000]/g, "").trim();
  } catch {
    return "";
  }
}
const [base, sessionId, wait] = process.argv.slice(2);
const spy = process.env.NODE_ENV === "test" ? process.env.IRON_OFFICE_BYE_SPY : "";
const waitMs = Math.min(1e3, Math.max(0, Number(wait) || 0));
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
        signal: AbortSignal.timeout(2500)
      });
    }
  }
} catch {
}
process.exit(0);
