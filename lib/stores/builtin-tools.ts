// Built-in tool category toggles.
//
// A category is "enabled" unless an explicit row in `builtin_tool_categories`
// says otherwise. Default-enabled semantics mean upgrading installs keep
// every category working with zero migration work.
//
// Disabled categories are filtered at three layers:
//   - GET /api/v1/tools (so the agent editor never offers them as permissions)
//   - getAllTools / getAllToolsAsync (so the agent runtime can't see them)
//   - executeTool (defense in depth, blocks stale agent configs)

import { getDb } from "@/lib/db";
import type { BuiltinCategory } from "@/lib/tools/registry";

interface Row {
  category: string;
  enabled: number;
  updated_at: string;
}

const now = () => new Date().toISOString();

export function isCategoryEnabled(category: BuiltinCategory): boolean {
  const row = getDb()
    .prepare("SELECT enabled FROM builtin_tool_categories WHERE category=?")
    .get(category) as { enabled: number } | undefined;
  return row ? row.enabled === 1 : true;
}

export function disabledCategories(): Set<BuiltinCategory> {
  const rows = getDb()
    .prepare("SELECT category FROM builtin_tool_categories WHERE enabled=0")
    .all() as unknown as Array<{ category: string }>;
  return new Set(rows.map((r) => r.category as BuiltinCategory));
}

export function listCategoryStates(): Array<{ category: string; enabled: boolean; updated_at: string | null }> {
  const rows = getDb()
    .prepare("SELECT category, enabled, updated_at FROM builtin_tool_categories")
    .all() as unknown as Row[];
  return rows.map((r) => ({
    category: r.category,
    enabled: r.enabled === 1,
    updated_at: r.updated_at,
  }));
}

export function setCategoryEnabled(category: BuiltinCategory, enabled: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO builtin_tool_categories (category, enabled, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(category) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`,
    )
    .run(category, enabled ? 1 : 0, now());
}
