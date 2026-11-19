// Timing wrapper for node:sqlite.
//
// DatabaseSync is fully synchronous: a slow statement is not "slow for that
// request", it stops every other request, timer and stream in the process.
// Wrapping prepare()/exec() lets the event-loop watchdog name the statement
// that was running when the app stopped answering instead of leaving only
// "health check timed out" in the logs.

import type { DatabaseSync, StatementSync } from "node:sqlite";
import { noteSlowStatement } from "@/lib/diagnostics/event-loop";

/** Statement calls timed by the wrapper. `iterate` is lazy, so it is not. */
const TIMED_STATEMENT_METHODS = new Set(["all", "get", "run"]);

export interface DatabaseInstrumentationOptions {
  /** Report statements at or above this duration. 0 reports everything. */
  slowMs?: number;
  /** Sink override for tests. */
  sink?: (sql: string, ms: number, rows: number | null) => void;
}

function rowCount(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return 1;
  return null;
}

export function instrumentDatabase(
  db: DatabaseSync,
  options: DatabaseInstrumentationOptions = {},
): DatabaseSync {
  const slowMs = options.slowMs ?? numberFromEnv("JARELA_SLOW_SQL_MS", 250);
  if (slowMs < 0) return db;
  const sink = options.sink ?? noteSlowStatement;

  const time = <T>(sql: string, run: () => T): T => {
    const started = performance.now();
    const result = run();
    const ms = performance.now() - started;
    if (ms >= slowMs) {
      try {
        sink(sql, ms, rowCount(result));
      } catch {
        /* diagnostics must never break a query */
      }
    }
    return result;
  };

  const wrapStatement = (statement: StatementSync, sql: string): StatementSync =>
    new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (typeof property === "string" && TIMED_STATEMENT_METHODS.has(property) && typeof value === "function") {
          return (...args: unknown[]) => time(sql, () => Reflect.apply(value, target, args));
        }
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });

  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property === "prepare" && typeof value === "function") {
        return (sql: string, ...rest: unknown[]) => {
          const statement = Reflect.apply(value, target, [sql, ...rest]) as StatementSync;
          return wrapStatement(statement, sql);
        };
      }
      if (property === "exec" && typeof value === "function") {
        return (sql: string, ...rest: unknown[]) => time(sql, () => Reflect.apply(value, target, [sql, ...rest]));
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
