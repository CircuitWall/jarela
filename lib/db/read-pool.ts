import sqlite3 from "@appthreat/sqlite3";

type SqliteReadPool = Awaited<ReturnType<typeof sqlite3.pool>>;

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

async function getReadPool(filename: string): Promise<SqliteReadPool> {
  if (!poolPromise) {
    poolPromise = sqlite3.pool(filename, { readers: 4, walMode: true })
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
