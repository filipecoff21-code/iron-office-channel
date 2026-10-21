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
