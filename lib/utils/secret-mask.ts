// Mask sentinels used across the codebase for redacted secret fields.
//
// Two were in flight before this helper unified them:
//   - The legacy `lib/stores/integrations.ts` exports SECRET_MASK = "********"
//     (8 stars) and the GET status routes emit that.
//   - The newer `app/api/v1/credentials/route.ts` hard-codes "***" (3 stars).
//
// The form components used to compare against only one of these, so values
// pre-populated from the other API silently slipped past the "is masked?"
// check and got persisted/transmitted as the literal sentinel — which Google's
// OAuth token endpoint rejects with `invalid_client_secret`.
//
// Use `isMaskedSecret(v)` everywhere a secret field is read back from the
// server and may have been redacted. New code should treat both sentinels as
// "user did not re-enter this value".
export const SECRET_MASKS = ["***", "********"] as const;

export function isMaskedSecret(v: unknown): boolean {
  return typeof v === "string" && (SECRET_MASKS as readonly string[]).includes(v);
}
