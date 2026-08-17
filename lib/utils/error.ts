// Coerce an arbitrary thrown value to a string message. Standardises the
// `e instanceof Error ? e.message : String(e)` pattern used across
// error-handler call sites so route handlers, stores, and UI panels all
// surface the same shape for unknown thrown values.
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const MAX_ERROR_BODY_LENGTH = 500;

// Reads an HTTP error response body for inclusion in a thrown/logged error
// message. HTML error pages (e.g. GitHub's multi-KB "Unicorn!" 502 page) are
// suppressed entirely rather than dumped into the message; any other body is
// capped at MAX_ERROR_BODY_LENGTH. Falls back to res.statusText if the body
// can't be read (e.g. already consumed).
export async function readErrorBody(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("html")) {
    return `<${contentType.split(";")[0] || "text/html"} response, no body shown>`;
  }
  const text = await res.text().catch(() => res.statusText);
  return text.length > MAX_ERROR_BODY_LENGTH ? `${text.slice(0, MAX_ERROR_BODY_LENGTH)}…` : text;
}
