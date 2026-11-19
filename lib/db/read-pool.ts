import type sqlite3Type from "@appthreat/sqlite3";
import { DB_PATH } from "./index";

type SqliteReadPool = Awaited<ReturnType<typeof sqlite3Type.pool>>;

let poolPromise: Promise<SqliteReadPool> | null = null;

/**
 * Run one read query using worker-owned, read-only SQLite connections.
 * Callers should expose this only through typed store methods so a read's
 * async contract is visible at the application boundary.
 */
export async function readRowsAsync<T extends object = Record<string, unknown>>(
  filename: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const pool = await getReadPool(filename);
  return await pool.read(sql, [...params]) as unknown as T[];
}

/**
 * Read against the app database on the read-only worker pool. Use this for
 * any read that can grow with user data (chunk tables, message history): the
 * write connection is synchronous, so the same query on the main thread
 * freezes every HTTP handler, stream and timer until it finishes.
 */
export async function readAppRows<T extends object = Record<string, unknown>>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return readRowsAsync<T>(DB_PATH, sql, params);
}

async function getReadPool(filename: string): Promise<SqliteReadPool> {
  if (!poolPromise) {
    // Deferred so merely importing this module (every threads.ts caller,
    // sync or async) doesn't pay for loading the native addon — only the
    // first actual async read does.
    poolPromise = import("@appthreat/sqlite3")
      .then(({ default: sqlite3 }) => sqlite3.pool(filename, { readers: 4, walMode: true }))
      .catch((error: unknown) => {
        poolPromise = null;
        throw error;
      });
  }
  return poolPromise;
}

/** Drain and close worker connections during shutdown and isolated tests. */
export async function closeReadPool(): Promise<void> {
  const pool = poolPromise;
  poolPromise = null;
  if (pool) await (await pool).close();
}
