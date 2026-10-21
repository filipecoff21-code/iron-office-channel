// Iron Office — partes comuns ao hook de telemetria e ao servidor do canal (0.5.0):
// os padrões de segredo apagados de todo texto que sai, e a chave `office_feed` do ~/.iron/config.yaml.
import { readFileSync } from "node:fs";
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
  /["']?\b[\w-]*(?:key|token|secret|password|passwd|pwd|pass)[\w-]*\b["']?\s*:\s*["'][^"']*["']/gi, // "campo": "valor" (JSON/YAML)
  /--?(?:password|passwd|pass|token|secret|api-?key|auth|access-token)(?:[=\s]+)\S+/gi, // --password X, --token=X
  /(\s-p)(?!\s)\S+/g, // mysql -pSENHA (grudado; `mkdir -p x` não casa)
  /(\s-u\s+)[^\s:]+:\S+/g, // curl -u usuario:senha
  /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD)[A-Z0-9_]*)\s*[=:]\s*\S+/gi,
  /:\/\/[^\s/:@]+:[^\s/@]+@/g, // usuário:senha em URL
];

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
// pasta e os conectores da presença. Sem o arquivo, sem a chave ou com valor desconhecido: ligado (padrão).
export function feedOn(home = homedir()) {
  try {
    const m = readFileSync(join(home, ".iron", "config.yaml"), "utf8").match(/^office_feed:\s*["']?(on|off)["']?\s*(?:#.*)?$/m);
    return !(m && m[1] === "off");
  } catch {
    return true;
  }
}
