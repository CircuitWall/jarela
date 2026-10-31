import { getDb } from "@/lib/db";
import { parseJsonSafe } from "@/lib/utils/json";

// Only settings whose owning reader explicitly permits a null fallback.
export function readJsonSetting<T>(key: string): T | null {
  const row = getDb()
    .prepare("SELECT value FROM memory_store WHERE namespace=? AND key=?")
    .get("app-settings", key) as { value?: string } | undefined;
  return row?.value ? parseJsonSafe<T | null>(row.value, null) : null;
}
