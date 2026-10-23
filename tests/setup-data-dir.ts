// Gives every test file its own empty data directory. Without this, any test
// that reaches lib/db without setting JARELA_DB_DIR itself writes into the
// user's real %LOCALAPPDATA%\Jarela or ~/.jarela database, and contends for
// its lock with a running Jarela ("database is locked"). Files that need a
// specific directory can still override JARELA_DB_DIR at the top of the file,
// because setup files run first.
import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "jarela-test-data-"));
process.env.JARELA_DB_DIR = dataDir;

afterAll(() => {
  // Windows keeps open SQLite handles locked, so cleanup is best effort.
  try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* */ }
});
