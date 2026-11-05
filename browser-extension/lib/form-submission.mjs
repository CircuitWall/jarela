const MAX_FIELD_COUNT = 20;
const MAX_LABEL_LENGTH = 200;
const MAX_VALUE_LENGTH = 500;
const MAX_TITLE_LENGTH = 300;

const PREFERENCE_LABEL = /\b(?:preference|preferred|favorite|favourite|like|dislike|interest|hobby|language|locale|tone|style|format|theme|color scheme|colour scheme|notification|reminder|subscription|delivery|communication|time ?zone)\b/i;
const SENSITIVE_LABEL = /\b(?:password|passcode|one.?time|verification|auth(?:entication)?|secret|token|api.?key|credit.?card|card.?number|cvv|cvc|iban|bank|routing|account.?number|social.?security|ssn|tax.?id|birth(?:day|date)?|phone|email address|address|name|personal info|contact details|health|medical|diagnos|disabilit|religion|politic|ethnic|racial|sexual orientation|biometric)\b/i;
const SENSITIVE_HOST = /(?:^|\.)(?:bank|banking|finance|payment|checkout|health|healthcare|medical|clinic|hospital|insurance|tax|identity|auth|login|mail|email)(?:\.|$)/i;
const EMAIL_VALUE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const SSN_VALUE = /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/;
const LONG_NUMBER_VALUE = /(?:\d[ -]?){13,19}/;
const PHONE_VALUE = /(?:\+?\d[\s().-]*){10,}/;

function cleanText(value, maxLength) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";
}

function safeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
      || url.hostname.endsWith(".localhost")) return null;
    if (SENSITIVE_HOST.test(url.hostname)) return null;
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

export function sanitizeSubmissionUrl(rawUrl) {
  const url = safeUrl(rawUrl);
  return url ? { site: url.hostname, url: url.href } : null;
}

function isSensitiveValue(value) {
  return EMAIL_VALUE.test(value)
    || SSN_VALUE.test(value)
    || LONG_NUMBER_VALUE.test(value)
    || PHONE_VALUE.test(value);
}

export function sanitizeSubmittedFields(fields) {
  if (!Array.isArray(fields)) return [];
  const safe = [];
  for (const field of fields) {
    const label = cleanText(field?.label, MAX_LABEL_LENGTH);
    const value = cleanText(field?.value, MAX_VALUE_LENGTH);
    if (!label || !value || !PREFERENCE_LABEL.test(label) || SENSITIVE_LABEL.test(label)) continue;
    if (isSensitiveValue(value)) continue;
    safe.push({ label, value });
    if (safe.length >= MAX_FIELD_COUNT) break;
  }
  return safe;
}

export function collectFormSubmission(form, { href, title, submittedAt } = {}) {
  if (!form || typeof form.elements?.[Symbol.iterator] !== "function") return null;
  const safePage = sanitizeSubmissionUrl(href);
  if (!safePage) return null;

  const fields = [];
  for (const control of form.elements) {
    const tag = control?.tagName?.toLowerCase();
    if (!["input", "select", "textarea"].includes(tag) || control.disabled) continue;

    const type = String(control.type || "").toLowerCase();
    if (["hidden", "password", "file", "email", "tel", "url", "submit", "button", "reset", "image"].includes(type)) continue;
    if ((type === "checkbox" || type === "radio") && !control.checked) continue;

    const labelText = Array.from(control.labels ?? [])
      .map((label) => label.innerText || label.textContent || "")
      .join(" ");
    const label = [
      labelText,
      control.getAttribute?.("aria-label") || "",
      control.getAttribute?.("placeholder") || "",
      control.name || "",
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

    let value;
    if (tag === "select" && control.multiple) {
      value = Array.from(control.selectedOptions).map((option) => option.label || option.value).join(", ");
    } else if (tag === "select") {
      value = control.selectedOptions?.[0]?.label || control.value;
    } else if (type === "checkbox" || type === "radio") {
      value = control.value || "selected";
    } else {
      value = control.value;
    }

    fields.push({ label, value });
  }

  const safeFields = sanitizeSubmittedFields(fields);
  if (safeFields.length === 0) return null;

  return {
    site: safePage.site,
    url: safePage.url,
    title: cleanText(title, MAX_TITLE_LENGTH),
    submitted_at: typeof submittedAt === "string" ? submittedAt : new Date().toISOString(),
    fields: safeFields,
  };
}
