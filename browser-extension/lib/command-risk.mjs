const SENSITIVE_HOST_RE = /(^|\.)(accounts|account|auth|login|signin|bank|bankid|checkout|pay|payment|billing|admin|mail|inbox|drive|docs|files|storage)\b/i;
const SENSITIVE_FIELD_RE = /(pass(word)?|token|secret|key|otp|mfa|2fa|code|ssn|personnummer|card|cc|cvc|cvv|iban|account|routing|bank|amount|salary|email|phone|address)/i;
const SENSITIVE_SELECTOR_RE = /(type=["']?password|autocomplete=["']?(cc-|one-time-code|current-password|new-password)|name=["']?.*(pass|token|secret|otp|card|cvv|cvc|iban|ssn|personnummer)|id=["']?.*(pass|token|secret|otp|card|cvv|cvc|iban|ssn|personnummer))/i;

export function classifyCommandRisk(command, context = {}) {
  const type = command?.type;
  const host = String(context.host || "");
  const url = String(context.url || command?.url || "");
  const reasons = [];

  if (SENSITIVE_HOST_RE.test(host) || SENSITIVE_HOST_RE.test(url)) {
    reasons.push("sensitive site");
  }

  if (type === "screenshot") reasons.push("captures visible page pixels");
  if (type === "extract" && !command?.selector) reasons.push("reads the whole page");
  if (type === "extract" && command?.format && command.format !== "text") reasons.push("reads page markup");

  if (type === "fill") {
    if (SENSITIVE_SELECTOR_RE.test(String(command.selector || ""))) reasons.push("sensitive field selector");
    if (looksSensitiveValue(command.value)) reasons.push("sensitive-looking value");
  }

  if (type === "fill_many") {
    const fields = Array.isArray(command.fields) ? command.fields : [];
    if (fields.length >= 5) reasons.push("batch form fill");
    for (const field of fields) {
      const selector = String(field?.selector || "");
      if (SENSITIVE_SELECTOR_RE.test(selector) || SENSITIVE_FIELD_RE.test(selector)) {
        reasons.push("sensitive field in batch fill");
        break;
      }
      if (looksSensitiveValue(field?.value)) {
        reasons.push("sensitive-looking value in batch fill");
        break;
      }
    }
  }

  const unique = Array.from(new Set(reasons));
  if (unique.length === 0) return { level: "normal", reasons: [], force_prompt: false };
  return { level: "sensitive", reasons: unique, force_prompt: true };
}

function looksSensitiveValue(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length === 0) return false;
  if (/^\d{6}$/.test(v)) return true;
  if (/\b\d{13,19}\b/.test(v.replace(/[ -]/g, ""))) return true;
  if (/^[A-Za-z0-9_-]{24,}$/.test(v) && /[A-Z]/.test(v) && /\d/.test(v)) return true;
  return false;
}