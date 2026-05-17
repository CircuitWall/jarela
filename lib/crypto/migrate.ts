// One-time, idempotent migration that rewrites legacy plaintext values
// in the four secret-bearing surfaces with `enc:v1:` envelopes
// (ADR-0005). Safe to run on every boot — already-encrypted rows are
// detected by the prefix and skipped.

import type { DatabaseSync } from "node:sqlite";
import { encrypt, isEncrypted } from "./envelope";
import { SENSITIVE_MEMORY_NAMESPACES } from "./sensitive";

interface MemoryStoreRow { namespace: string; key: string; value: string }
interface ModelConfigRow { name: string; params: string }
interface McpServerRow { name: string; spec: string }

export function runCryptoMigration(db: DatabaseSync): void {
  let touched = 0;

  // 1) memory_store rows in sensitive namespaces.
  const nsList = [...SENSITIVE_MEMORY_NAMESPACES];
  const placeholders = nsList.map(() => "?").join(",");
  const memoryRows = db
    .prepare(`SELECT namespace, key, value FROM memory_store WHERE namespace IN (${placeholders})`)
    .all(...nsList) as unknown as MemoryStoreRow[];
  const memUpdate = db.prepare(
    "UPDATE memory_store SET value=?, updated_at=? WHERE namespace=? AND key=?",
  );
  const now = new Date().toISOString();
  for (const row of memoryRows) {
    if (isEncrypted(row.value)) continue;
    memUpdate.run(encrypt(row.value), now, row.namespace, row.key);
    touched++;
  }

  // 2) model_configs.params — every row.
  const modelRows = db
    .prepare("SELECT name, params FROM model_configs")
    .all() as unknown as ModelConfigRow[];
  const modelUpdate = db.prepare(
    "UPDATE model_configs SET params=?, updated_at=? WHERE name=?",
  );
  for (const row of modelRows) {
    if (isEncrypted(row.params)) continue;
    modelUpdate.run(encrypt(row.params), now, row.name);
    touched++;
  }

  // 3) mcp_servers.spec — every row.
  const mcpRows = db
    .prepare("SELECT name, spec FROM mcp_servers")
    .all() as unknown as McpServerRow[];
  const mcpUpdate = db.prepare(
    "UPDATE mcp_servers SET spec=?, updated_at=? WHERE name=?",
  );
  for (const row of mcpRows) {
    if (isEncrypted(row.spec)) continue;
    mcpUpdate.run(encrypt(row.spec), now, row.name);
    touched++;
  }

  if (touched > 0) {
    console.info(`[jarela] encrypted ${touched} legacy plaintext secret row(s) at rest`);
  }
}
