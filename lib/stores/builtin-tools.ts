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

// Every agent can always list/read/write skills, regardless of its own tool
// selection (lib/agents/run-thread.ts#SELF_CONFIG_TOOLS) — so unlike other
// builtin categories, this one can never be disabled.
const ALWAYS_ON: ReadonlySet<BuiltinCategory> = new Set(["Skills"]);

export function isCategoryEnabled(category: BuiltinCategory): boolean {
  if (ALWAYS_ON.has(category)) return true;
  const row = getDb()
    .prepare("SELECT enabled FROM builtin_tool_categories WHERE category=?")
    .get(category) as { enabled: number } | undefined;
  return row ? row.enabled === 1 : true;
}

export function disabledCategories(): Set<BuiltinCategory> {
  const rows = getDb()
    .prepare("SELECT category FROM builtin_tool_categories WHERE enabled=0")
    .all() as unknown as Array<{ category: string }>;
  const disabled = new Set(rows.map((r) => r.category as BuiltinCategory));
  for (const c of ALWAYS_ON) disabled.delete(c);
  return disabled;
}

export function listCategoryStates(): Array<{ category: string; enabled: boolean; updated_at: string | null }> {
  const rows = getDb()
    .prepare("SELECT category, enabled, updated_at FROM builtin_tool_categories")
    .all() as unknown as Row[];
  return rows.map((r) => ({
    category: r.category,
    enabled: ALWAYS_ON.has(r.category as BuiltinCategory) ? true : r.enabled === 1,
    updated_at: r.updated_at,
  }));
}

export function setCategoryEnabled(category: BuiltinCategory, enabled: boolean): void {
  if (ALWAYS_ON.has(category) && !enabled) return;
  getDb()
    .prepare(
      `INSERT INTO builtin_tool_categories (category, enabled, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(category) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`,
    )
    .run(category, enabled ? 1 : 0, now());
}
