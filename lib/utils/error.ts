// Coerce an arbitrary thrown value to a string message. Standardises the
// `e instanceof Error ? e.message : String(e)` pattern used across
// error-handler call sites so route handlers, stores, and UI panels all
// surface the same shape for unknown thrown values.
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
