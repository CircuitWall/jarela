// Translate raw SQLite constraint errors to domain-friendly errors.
//
// SQLite throws "SQLITE_CONSTRAINT: UNIQUE constraint failed: threads.agent_id"
// when an INSERT violates a UNIQUE index, and "FOREIGN KEY constraint failed"
// for FK violations. Without translation the API responds with that raw text
// — which leaks the schema and reads like a bug to users.
//
// Stores that catch a constraint violation can call `domainErrorFor()` to
// turn it into a typed `DomainConstraintError` carrying a stable `code`
// (`unique_violation` / `foreign_key_violation`) and a friendly message.
// API routes catch the typed error and return `errorResponse(msg, 409, code)`.
//
// See ADR-0053.

export class DomainConstraintError extends Error {
  readonly code: "unique_violation" | "foreign_key_violation";
  /** The table + column the constraint covers, when extractable. */
  readonly target?: string;
  constructor(code: "unique_violation" | "foreign_key_violation", message: string, target?: string) {
    super(message);
    this.name = "DomainConstraintError";
    this.code = code;
    this.target = target;
  }
}

export function isConstraintError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string };
  if (typeof e.code === "string" && e.code.startsWith("SQLITE_CONSTRAINT")) return true;
  if (typeof e.message === "string" && /SQLITE_CONSTRAINT/i.test(e.message)) return true;
  return false;
}

/**
 * Translate a SQLite constraint error into a `DomainConstraintError`.
 * Returns the original error unchanged when it doesn't match the constraint
 * pattern — caller can rethrow safely.
 */
export function domainErrorFor(err: unknown): unknown {
  if (!isConstraintError(err)) return err;
  const message = (err as { message?: string }).message ?? "";

  // "UNIQUE constraint failed: threads.agent_id"
  const uniq = message.match(/UNIQUE constraint failed:\s*([\w.]+)/i);
  if (uniq) {
    const target = uniq[1];
    return new DomainConstraintError(
      "unique_violation",
      `A row with this value already exists (${target}). Use update instead of insert, or pick a different identifier.`,
      target,
    );
  }

  // "FOREIGN KEY constraint failed"
  if (/FOREIGN KEY constraint failed/i.test(message)) {
    return new DomainConstraintError(
      "foreign_key_violation",
      "Referenced row does not exist or has been deleted. Check the parent record and retry.",
    );
  }

  // Other constraint variants (CHECK, NOT NULL): pass through unchanged.
  return err;
}
