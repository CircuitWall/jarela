import { parseJsonSafe } from "@/lib/utils/json";
import { isMaskedSecret } from "@/lib/utils/secret-mask";

const SECRET_FIELDS = ["api_key", "client_secret", "refresh_token", "access_token"] as const;

export function redactInlineModelParams(raw: string): Record<string, unknown> {
  const parsed = parseJsonSafe<Record<string, unknown>>(raw, {});
  const safe: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(parsed)) {
    safe[field] = SECRET_FIELDS.some((secret) => secret === field)
      && typeof value === "string" && value.length > 0 ? "***" : value;
  }
  return safe;
}

// Resolve echoed masks from the row read inside the caller's mutation lock.
// Missing rows retain the existing upsert behavior; omitted fields stay omitted.
export function preserveInlineModelSecrets(
  incoming: Record<string, unknown>,
  existingRaw: string | undefined,
): Record<string, unknown> {
  if (existingRaw === undefined) return incoming;
  const existing = parseJsonSafe<Record<string, unknown>>(existingRaw, {});
  const out = { ...incoming };
  for (const field of SECRET_FIELDS) {
    if (isMaskedSecret(out[field])) {
      const prior = existing[field];
      if (typeof prior === "string" && prior.length > 0) out[field] = prior;
      else delete out[field];
    }
  }
  return out;
}
