/**
 * Normalize an unknown thrown value to a human-readable string.
 *
 * Use everywhere a `catch (e: unknown)` block needs to surface a message —
 * replaces the `e instanceof Error ? e.message : String(e)` boilerplate that
 * was duplicated across ~15 UI sites.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
