import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { registeredTools, registeredCategory, type BuiltinCategory } from "@/lib/tools/registry";
import {
  disabledCategories,
  setCategoryEnabled,
} from "@/lib/stores/builtin-tools";

// All built-in categories the registry knows about, with their tool count
// and current enabled state. Default-enabled (no row = on). Used by the
// Tools tab to render per-category on/off toggles.

const ALL_VALID_CATEGORIES = new Set<string>([
  "Memory", "Documents", "Files", "Shell", "Web", "Images", "Voice",
  "Schedule", "Atlassian", "JiraAlign", "GitHub", "Mail", "Calendar", "Config",
]);

interface CategoryRow {
  category: BuiltinCategory;
  enabled: boolean;
  toolCount: number;
  toolNames: string[];
}

function listCategories(): CategoryRow[] {
  const disabled = disabledCategories();
  const byCat = new Map<BuiltinCategory, string[]>();
  for (const t of registeredTools()) {
    const cat = registeredCategory(t.name);
    if (!cat) continue;
    const arr = byCat.get(cat) ?? [];
    arr.push(t.name);
    byCat.set(cat, arr);
  }
  const rows: CategoryRow[] = [];
  for (const [cat, names] of byCat) {
    rows.push({
      category: cat,
      enabled: !disabled.has(cat),
      toolCount: names.length,
      toolNames: names.sort(),
    });
  }
  rows.sort((a, b) => a.category.localeCompare(b.category));
  return rows;
}

export async function GET() {
  return NextResponse.json(listCategories());
}

const PatchSchema = z.object({
  category: z.string(),
  enabled: z.boolean(),
});

export async function PATCH(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid input" }, { status: 400 });
  }
  const { category, enabled } = parsed.data;
  if (!ALL_VALID_CATEGORIES.has(category)) {
    return NextResponse.json({ error: `unknown category: ${category}` }, { status: 400 });
  }
  setCategoryEnabled(category as BuiltinCategory, enabled);
  return NextResponse.json({ category, enabled });
}
