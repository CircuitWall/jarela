// Sanitize an OAuth client_id / client_secret coming from a user paste.
//
// Strips ALL whitespace (spaces, tabs, newlines) and the zero-width chars
// password managers and clipboards sometimes inject (U+200B..U+200D, U+FEFF).
// Google / Microsoft OAuth secrets are alphanumeric+hyphens with no internal
// whitespace, so this is safe and catches the "the secret matches but Google
// rejects it" class of bugs.
export function sanitizeOAuthInput(v: string | undefined | null): string | undefined {
  if (typeof v !== "string") return undefined;
  const cleaned = v.replace(/[\s\u200B-\u200D\uFEFF]+/g, "");
  return cleaned.length > 0 ? cleaned : undefined;
}

// Build a non-leaking fingerprint of a secret for diagnostic logs.
// Format: "len=<n> head=<first 2> tail=<last 4>". Returns "<none>" for empty.
export function secretFingerprint(v: string | undefined | null): string {
  if (typeof v !== "string" || v.length === 0) return "<none>";
  const head = v.slice(0, 2);
  const tail = v.length > 6 ? v.slice(-4) : "";
  return `len=${v.length} head=${head} tail=${tail}`;
}
