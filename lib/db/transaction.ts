import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

export function withDbTransaction<Result>(work: () => Result): Result {
  const savepoint = `jarela_${randomUUID().replaceAll("-", "")}`;
  const db = getDb();
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = work();
    db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO ${savepoint}`);
    db.exec(`RELEASE ${savepoint}`);
    throw error;
  }
}