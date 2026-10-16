/**
 * Source-link fields for tool results, so an agent can link a reply back to
 * the email, calendar event, or chat it came from without building URLs.
 *
 * `cite_as` is a ready-made markdown link the system prompt tells agents to
 * paste verbatim. Building it in code keeps the label and URL well-formed:
 * a stray `]` in a subject or `)` in a URL would otherwise break the link.
 */

const MAX_LABEL_CHARS = 80;

/** Returns `url` when it is an absolute https URL, otherwise null. */
export function httpsUrlOrNull(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function markdownLabel(label: string | null | undefined, fallback: string): string {
  const flat = (label ?? "").replace(/\s+/g, " ").trim();
  const capped = flat.length > MAX_LABEL_CHARS ? `${flat.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…` : flat;
  return (capped || fallback).replace(/[\\[\]]/g, (c) => `\\${c}`);
}

function markdownDestination(url: string): string {
  return url.replace(/[()\s<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/**
 * Pre-built markdown link for `cite_as`, or null when there is no usable URL.
 * Only https URLs qualify: the chat renderer drops other schemes.
 */
export function citeAs(
  label: string | null | undefined,
  url: string | null | undefined,
  fallbackLabel = "source",
): string | null {
  const safe = httpsUrlOrNull(url);
  if (!safe) return null;
  return `[${markdownLabel(label, fallbackLabel)}](${markdownDestination(safe)})`;
}
