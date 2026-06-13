// Disabled-state for in-tree default LangChain packages.
//
// Default packages (Atlassian, GitHub, Jira Align — see
// lib/tools/default-packages.ts) ship with Jarela and are registered at
// process boot. Operators may want to silence one without uninstalling
// the npm dependency: this table records that intent.
//
// Missing row = enabled (default-on, matching builtin_tool_categories
// semantics). Disabled defaults are skipped during boot registration and
// can be flipped back on at runtime via the packages API.
import { getDb } from "@/lib/db";

const now = (): string => new Date().toISOString();

export function isPackageDisabled(id: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM disabled_packages WHERE id=?")
    .get(id) as { 1?: number } | undefined;
  return Boolean(row);
}

export function listDisabledPackages(): string[] {
  const rows = getDb()
    .prepare("SELECT id FROM disabled_packages ORDER BY id")
    .all() as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export function setPackageDisabled(id: string, disabled: boolean): void {
  const db = getDb();
  if (disabled) {
    db.prepare(
      `INSERT INTO disabled_packages (id, updated_at)
       VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at`,
    ).run(id, now());
  } else {
    db.prepare("DELETE FROM disabled_packages WHERE id=?").run(id);
  }
}
