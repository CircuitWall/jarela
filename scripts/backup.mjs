// `jarela backup [dest]` — personal, local backup of the Jarela data dir.
//
// Databases are captured with `VACUUM INTO`, which produces a consistent
// single-file snapshot even while the server holds them open in WAL mode.
// Key material and bridge session credentials are never copied: secrets in
// the database stay encrypted and can only be read with the original master
// key (OS keychain, `.secret-key`, or PIN-wrapped `.secret-key.enc`).

import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const DATABASES = ["jarela.db", "checkpoints.db"];
const DIRECTORIES = ["files", "providers", "tools", "packages"];
const MANIFEST = "jarela-backup.json";
// Loaded lazily so `jarela --help` never triggers the node:sqlite warning.
const require = createRequire(import.meta.url);

export function resolveDataDir(env = process.env, platform = process.platform, home = homedir()) {
  const configured = env.JARELA_DB_DIR;
  if (configured) return configured.startsWith("~") ? join(home, configured.slice(1)) : configured;
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Jarela");
  return join(home, ".jarela");
}

// Resolve links so a symlink or junction cannot smuggle the target into the data dir.
// For paths that don't exist yet, realpath the nearest existing ancestor.
function realTarget(path) {
  let current = resolve(path);
  const rest = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(basename(current));
    current = parent;
  }
  try {
    current = realpathSync.native(current);
  } catch {
    /* keep the lexical path */
  }
  return join(current, ...rest);
}

function isInside(parent, child) {
  const rel = relative(realTarget(parent), realTarget(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sqlString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

export function runBackup({ dataDir = resolveDataDir(), dest, now = new Date(), log = console.log } = {}) {
  const target = resolve(dest ?? `jarela-backup-${now.toISOString().replace(/[:.]/g, "-")}`);

  if (!existsSync(join(dataDir, "jarela.db"))) {
    log(`[jarela] backup failed: no jarela.db in ${dataDir}. Set JARELA_DB_DIR if your data lives elsewhere.`);
    return 1;
  }
  if (isInside(dataDir, target)) {
    log(`[jarela] backup failed: ${target} is inside the data directory; choose a location outside ${dataDir}.`);
    return 1;
  }
  if (existsSync(target) && readdirSync(target).length > 0) {
    log(`[jarela] backup failed: ${target} is not empty; choose a new or empty folder.`);
    return 1;
  }

  mkdirSync(target, { recursive: true });
  return snapshot({ dataDir, target, now, log });
}

function snapshot({ dataDir, target, now, log }) {
  const { DatabaseSync } = require("node:sqlite");
  const included = [];
  try {
    for (const name of DATABASES) {
      const source = join(dataDir, name);
      if (!existsSync(source)) continue;
      const db = new DatabaseSync(source, { readOnly: true });
      try {
        db.exec(`VACUUM INTO ${sqlString(join(target, name))}`);
      } finally {
        db.close();
      }
      included.push(name);
    }
    for (const name of DIRECTORIES) {
      const source = join(dataDir, name);
      if (!existsSync(source)) continue;
      cpSync(source, join(target, name), { recursive: true });
      included.push(name);
    }
  } catch (err) {
    log(`[jarela] backup failed while copying: ${err?.message ?? err}`);
    return 1;
  }

  writeFileSync(
    join(target, MANIFEST),
    `${JSON.stringify({ format: 1, createdAt: now.toISOString(), dataDir, included, masterKeyIncluded: false }, null, 2)}\n`,
  );
  log(`[jarela] backup written to ${target} (${included.join(", ")}).`);
  log(
    "[jarela] The master key is not included. Saved credentials can only be decrypted on a machine " +
      "that still has the original key (OS keychain, .secret-key, or your PIN-wrapped .secret-key.enc); " +
      "otherwise re-enter them after restoring. Messaging bridges must be re-paired.",
  );
  return 0;
}
