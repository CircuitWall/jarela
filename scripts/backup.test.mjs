import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDir, runBackup } from "./backup.mjs";

const here = dirname(fileURLToPath(import.meta.url));

let root;
let dataDir;
let logs;
const log = (m) => logs.push(m);

function seedDataDir() {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "jarela.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?)").run("t1", "kept in wal");
  // Leave the connection open so the row may still live only in the WAL.
  const cp = new DatabaseSync(join(dataDir, "checkpoints.db"));
  cp.exec("CREATE TABLE checkpoints (id TEXT)");
  cp.close();
  mkdirSync(join(dataDir, "files"), { recursive: true });
  writeFileSync(join(dataDir, "files", "abc.png"), "png-bytes");
  mkdirSync(join(dataDir, "providers"), { recursive: true });
  writeFileSync(join(dataDir, "providers", "local.json"), "{}");
  writeFileSync(join(dataDir, ".secret-key"), Buffer.alloc(32, 1));
  writeFileSync(join(dataDir, ".secret-key.enc"), Buffer.alloc(64, 2));
  mkdirSync(join(dataDir, "baileys", "wa1"), { recursive: true });
  writeFileSync(join(dataDir, "baileys", "wa1", "creds.json"), "{}");
  mkdirSync(join(dataDir, "models", "local-embedding"), { recursive: true });
  writeFileSync(join(dataDir, "models", "local-embedding", "model.onnx"), "big");
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  writeFileSync(join(dataDir, "logs", "server.log"), "log");
  return db;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jarela-backup-"));
  dataDir = join(root, "data");
  logs = [];
});

afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

describe("runBackup", () => {
  it("snapshots both databases consistently while Jarela still has them open", () => {
    const live = seedDataDir();
    const dest = join(root, "out");
    const code = runBackup({ dataDir, dest, log });
    live.close();
    expect(code).toBe(0);
    const snap = new DatabaseSync(join(dest, "jarela.db"), { readOnly: true });
    expect(snap.prepare("SELECT title FROM threads").all()).toEqual([{ title: "kept in wal" }]);
    snap.close();
    expect(existsSync(join(dest, "checkpoints.db"))).toBe(true);
    expect(readdirSync(dest).some((n) => n.endsWith("-wal") || n.endsWith("-shm"))).toBe(false);
  });

  it("copies attachments and provider config but never key material or bridge sessions", () => {
    seedDataDir().close();
    const dest = join(root, "out");
    expect(runBackup({ dataDir, dest, log })).toBe(0);
    expect(readFileSync(join(dest, "files", "abc.png"), "utf8")).toBe("png-bytes");
    expect(existsSync(join(dest, "providers", "local.json"))).toBe(true);
    for (const excluded of [".secret-key", ".secret-key.enc", "baileys", "models", "logs"]) {
      expect(existsSync(join(dest, excluded))).toBe(false);
    }
  });

  it("writes a manifest that lists contents and warns that the master key is not included", () => {
    seedDataDir().close();
    const dest = join(root, "out");
    runBackup({ dataDir, dest, log, now: new Date("2025-01-02T03:04:05Z") });
    const manifest = JSON.parse(readFileSync(join(dest, "jarela-backup.json"), "utf8"));
    expect(manifest.createdAt).toBe("2025-01-02T03:04:05.000Z");
    expect(manifest.included).toEqual(expect.arrayContaining(["jarela.db", "checkpoints.db", "files", "providers"]));
    expect(manifest.masterKeyIncluded).toBe(false);
    expect(logs.join("\n")).toMatch(/master key is not included/i);
  });

  it("refuses to overwrite a non-empty destination", () => {
    seedDataDir().close();
    const dest = join(root, "out");
    mkdirSync(dest);
    writeFileSync(join(dest, "important.txt"), "keep me");
    expect(runBackup({ dataDir, dest, log })).toBe(1);
    expect(readdirSync(dest)).toEqual(["important.txt"]);
    expect(logs.join("\n")).toMatch(/not empty/i);
  });

  it("refuses a destination inside the data directory", () => {
    seedDataDir().close();
    expect(runBackup({ dataDir, dest: join(dataDir, "files", "bk"), log })).toBe(1);
    expect(existsSync(join(dataDir, "files", "bk"))).toBe(false);
    expect(logs.join("\n")).toMatch(/inside the data directory/i);
  });

  it("fails clearly when there is no Jarela database to back up", () => {
    mkdirSync(dataDir, { recursive: true });
    const dest = join(root, "out");
    expect(runBackup({ dataDir, dest, log })).toBe(1);
    expect(existsSync(dest)).toBe(false);
    expect(logs.join("\n")).toMatch(/no jarela\.db/i);
  });
});

describe("jarela backup CLI", () => {
  it("backs up JARELA_DB_DIR to the given folder and exits 0", () => {
    seedDataDir().close();
    const dest = join(root, "cli-out");
    const r = spawnSync(process.execPath, [join(here, "jarela-bin.mjs"), "backup", dest], {
      env: { ...process.env, JARELA_DB_DIR: dataDir, JARELA_DISABLE_UPDATE_CHECK: "1" },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(dest, "jarela.db"))).toBe(true);
    expect(existsSync(join(dest, ".secret-key"))).toBe(false);
  });

  it("exits 1 without touching an existing non-empty folder", () => {
    seedDataDir().close();
    const dest = join(root, "cli-out");
    mkdirSync(dest);
    writeFileSync(join(dest, "x"), "x");
    const r = spawnSync(process.execPath, [join(here, "jarela-bin.mjs"), "backup", dest], {
      env: { ...process.env, JARELA_DB_DIR: dataDir, JARELA_DISABLE_UPDATE_CHECK: "1" },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(readdirSync(dest)).toEqual(["x"]);
  });
});

describe("resolveDataDir", () => {
  it("honours JARELA_DB_DIR with home expansion", () => {
    expect(resolveDataDir({ JARELA_DB_DIR: "~/custom" }, "linux", "/home/u")).toBe(join("/home/u", "custom"));
  });

  it("matches the app defaults per platform", () => {
    expect(resolveDataDir({}, "linux", "/home/u")).toBe(join("/home/u", ".jarela"));
    expect(resolveDataDir({ LOCALAPPDATA: "C:\\L" }, "win32", "C:\\U")).toBe(join("C:\\L", "Jarela"));
  });
});
