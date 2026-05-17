// Resolves the Jarela data directory and performs a one-time migration from
// the legacy LangGUI layout (~/.langgui with langgui.db) when present.
//
// Per the LangGUI → Jarela rebrand (ADR-0005): no backward-compat for env
// vars or DB filenames is retained at the code level, but on first launch
// against a populated machine we rename the directory and DB files so
// existing users keep their data.

import { existsSync, mkdirSync, renameSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let cached: string | null = null;

function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace(/^~/, homedir()) : p;
}

function migrateLegacyDir(legacyDir: string, newDir: string): void {
  // Only migrate when the new dir is absent and the legacy dir exists.
  if (existsSync(newDir)) return;
  if (!existsSync(legacyDir)) return;

  try {
    renameSync(legacyDir, newDir);
  } catch (err) {
    // EPERM/EBUSY: another process (e.g. an installed scheduled task) is
    // holding the directory open. EXDEV: cross-volume rename. In both cases
    // we don't want to crash the host process — log a warning and continue
    // with whatever the new dir already contains (likely empty). The user
    // can retry by stopping the other process and re-launching.
    // eslint-disable-next-line no-console
    console.warn(
      `[jarela] could not migrate legacy data dir ${legacyDir} -> ${newDir}: ${
        (err as Error).message
      }. Continuing with the new dir; retry after stopping any other Jarela process.`,
    );
    return;
  }

  // Rename DB files: langgui.db -> jarela.db (and any -wal / -shm sidecars).
  let entries: string[] = [];
  try {
    entries = readdirSync(newDir);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    if (!name.startsWith("langgui.db")) continue;
    const suffix = name.slice("langgui.db".length); // "", "-wal", "-shm", "-journal"
    const from = join(newDir, name);
    const to = join(newDir, `jarela.db${suffix}`);
    try {
      renameSync(from, to);
    } catch {
      // Non-fatal: leave the file as-is. The DB layer will create fresh
      // files under the new name if needed.
    }
  }

  // eslint-disable-next-line no-console
  console.info(`[jarela] migrated data dir ${legacyDir} -> ${newDir}`);
}

export function getDataDir(): string {
  if (cached) return cached;

  const envDir = process.env.JARELA_DB_DIR;
  const newDir = envDir
    ? expandHome(envDir)
    : join(homedir(), ".jarela");

  // Only migrate the default location; if the user customized JARELA_DB_DIR
  // they're explicitly opting out of automatic migration.
  if (!envDir) {
    migrateLegacyDir(join(homedir(), ".langgui"), newDir);
  }

  mkdirSync(newDir, { recursive: true });
  cached = newDir;
  return newDir;
}
