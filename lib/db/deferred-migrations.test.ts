import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { wrapMasterKey } from "@/lib/crypto/pin-wrap";
import { __resetMasterKeyForTests, isMasterKeyLocked, unlockMasterKey } from "@/lib/crypto/master-key";

vi.mock("@/lib/proxy/dispatcher", () => ({ applyProxyConfigFromDb: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/env/sync", () => ({ runEnvSyncOnce: vi.fn().mockResolvedValue(null) }));

const { DB_PATH, getDb, closeDb } = await import("./index");

afterAll(() => {
  closeDb();
  __resetMasterKeyForTests();
});

it("keeps credential migration pending while locked and completes it after unlock", () => {
  __resetMasterKeyForTests();
  const dataDir = process.env.JARELA_DB_DIR;
  if (!dataDir) throw new Error("Missing isolated test data directory");
  writeFileSync(join(dataDir, ".secret-key.enc"), wrapMasterKey(Buffer.alloc(32, 0x31), "123456"));
  const oldDb = new DatabaseSync(DB_PATH);
  try {
    oldDb.exec(readFileSync(new URL("./fixtures/v3.0.0.sql", import.meta.url), "utf8"));
    oldDb.prepare("INSERT INTO model_configs (name, provider, model_id, params, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("legacy", "mock", "model", JSON.stringify({ api_key: "test-key" }), "date", "date");
  } finally {
    oldDb.close();
  }

  const db = getDb();
  expect(isMasterKeyLocked()).toBe(true);
  expect(db.prepare("SELECT id FROM jarela_migrations").all()).toEqual([{ id: "3.0.0-baseline" }]);
  unlockMasterKey("123456");
  expect(db.prepare("SELECT id FROM jarela_migrations ORDER BY id").all()).toEqual([
    { id: "3.0.0-baseline" },
    { id: "3.0.0-deferred-credentials" },
    { id: "3.0.0-deferred-crypto" },
  ]);
  expect(db.prepare("SELECT credential_id FROM model_configs WHERE name='legacy'").get())
    .toEqual({ credential_id: "model-mock" });
});
