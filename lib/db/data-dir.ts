// Resolves the Jarela data directory and performs one-time migrations:
//
//   1. Legacy LangGUI layout (~/.langgui with langgui.db) — rebrand
//      migration: rename the dir + the DB files.
//   2. On Windows, ~/.jarela → %LOCALAPPDATA%\Jarela (ADR-0006) to escape
//      OneDrive-synced user-profile paths.
//
// No backward-compat for env vars is retained at the code level; both
// migrations are best-effort renames on first launch against a populated
// machine so existing users keep their data.

import { existsSync, mkdirSync, renameSync, readdirSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let cached: string | null = null;

function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace(/^~/, homedir()) : p;
}

// A dir "has DB" iff it contains jarela.db OR langgui.db. We treat the
// presence of a DB as the signal that the dir holds real user state;
// otherwise it may just be a vestigial launcher working dir
// (e.g. %LOCALAPPDATA%\Jarela created by installed-launcher.vbs with
// only files/ and logs/ inside).
function hasDb(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((n) => n === "jarela.db" || n === "langgui.db");
  } catch {
    return false;
  }
}

function migrateLegacyDir(legacyDir: string, newDir: string): void {
  if (!existsSync(legacyDir)) return;
  if (hasDb(newDir)) return; // new dir already has user state — never overwrite.

  mkdirSync(newDir, { recursive: true });

  // Move contents item-by-item so we can merge into a partially-existing
  // newDir (e.g. one containing only logs/ from a prior launcher run).
  // Skips items that already exist on the destination side.
  let entries: string[] = [];
  try { entries = readdirSync(legacyDir); } catch { entries = []; }

  let moved = 0;
  for (const name of entries) {
    const from = join(legacyDir, name);
    const to = join(newDir, name);
    if (existsSync(to)) continue;
    try {
      renameSync(from, to);
      moved++;
    } catch (err) {
      // EXDEV: cross-volume rename. EPERM/EBUSY: locked by another
      // process. Non-fatal: skip this item and continue with the rest.
      console.warn(
        `[jarela] could not move ${from} -> ${to}: ${(err as Error).message}`,
      );
    }
  }

  // Rename DB files: langgui.db -> jarela.db (and any -wal / -shm sidecars).
  let postEntries: string[] = [];
  try { postEntries = readdirSync(newDir); } catch { postEntries = []; }
  for (const name of postEntries) {
    if (!name.startsWith("langgui.db")) continue;
    const suffix = name.slice("langgui.db".length); // "", "-wal", "-shm", "-journal"
    const from = join(newDir, name);
    const to = join(newDir, `jarela.db${suffix}`);
    if (existsSync(to)) continue;
    try { renameSync(from, to); } catch { /* leave as-is; DB layer recreates */ }
  }

  // Best-effort cleanup of an emptied legacy dir. If anything remained
  // (locked files, dotfiles we declined to move) leave the dir in place.
  try {
    if (readdirSync(legacyDir).length === 0) {
      rmdirSync(legacyDir);
    }
  } catch { /* */ }

  if (moved > 0) {
    console.info(`[jarela] migrated ${moved} entries from ${legacyDir} -> ${newDir}`);
  }
}

export function getDataDir(): string {
  if (cached) return cached;

  const envDir = process.env.JARELA_DB_DIR;
  const newDir = envDir ? expandHome(envDir) : defaultDataDir();

  // Only run automatic migrations for the default location; if the user
  // customized JARELA_DB_DIR they're explicitly opting out.
  if (!envDir) {
    // Chain order matters: rebrand first so a ~/.langgui from the old
    // build lands at ~/.jarela, then the Windows-only move lifts that to
    // %LOCALAPPDATA%\Jarela in the same boot.
    migrateLegacyDir(join(homedir(), ".langgui"), join(homedir(), ".jarela"));
    if (process.platform === "win32" && newDir !== join(homedir(), ".jarela")) {
      migrateLegacyDir(join(homedir(), ".jarela"), newDir);
    }
  }

  mkdirSync(newDir, { recursive: true });
  cached = newDir;
  return newDir;
}

function defaultDataDir(): string {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(local, "Jarela");
  }
  return join(homedir(), ".jarela");
}
