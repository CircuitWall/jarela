import { useMemo } from "react";
import type { ToolInfo } from "@/api/types";
import { permissionKindForTool, type ToolPermissionKind } from "./permissions";

export interface GroupedTools {
  groupedTools: Array<{ group: string | null; categories: Array<[string, ToolInfo[]]> }>;
  toggleTool: (name: string) => void;
  toggleAllTools: () => void;
  toggleCategory: (category: string, enable: boolean) => void;
  toggleCategoryPermission: (category: string, kind: ToolPermissionKind, enable: boolean) => void;
  toggleGroup: (group: string, enable: boolean) => void;
}

export function useAgentToolHandlers(
  tools: ToolInfo[],
  setSelectedTools: React.Dispatch<React.SetStateAction<string[]>>,
): GroupedTools {
  const groupedTools = useMemo(() => buildGroupedTools(tools), [tools]);
  const allCategories = useMemo(() => groupedTools.flatMap((g) => g.categories), [groupedTools]);

  const toggleTool = (toolName: string) =>
    setSelectedTools((p) => p.includes(toolName) ? p.filter((n) => n !== toolName) : [...p, toolName]);

  const toggleAllTools = () =>
    setSelectedTools((p) => p.length === tools.length ? [] : tools.map((t) => t.name));

  const toggleCategory = (category: string, enable: boolean) => {
    const names = allCategories.find(([c]) => c === category)?.[1].map((t) => t.name) ?? [];
    applyBulkSelection(names, enable, setSelectedTools);
  };

  const toggleCategoryPermission = (category: string, kind: ToolPermissionKind, enable: boolean) => {
    const cat = allCategories.find(([c]) => c === category)?.[1] ?? [];
    const names = cat.filter((t) => permissionKindForTool(t.name, category) === kind).map((t) => t.name);
    applyBulkSelection(names, enable, setSelectedTools);
  };

  const toggleGroup = (group: string, enable: boolean) => {
    const names = (groupedTools.find((g) => g.group === group)?.categories ?? [])
      .flatMap(([, ts]) => ts.map((t) => t.name));
    applyBulkSelection(names, enable, setSelectedTools);
  };

  return { groupedTools, toggleTool, toggleAllTools, toggleCategory, toggleCategoryPermission, toggleGroup };
}

function applyBulkSelection(
  names: string[],
  enable: boolean,
  setSelectedTools: React.Dispatch<React.SetStateAction<string[]>>,
) {
  if (names.length === 0) return;
  setSelectedTools((prev) => {
    if (enable) {
      const set = new Set(prev);
      for (const n of names) set.add(n);
      return [...set];
    }
    const remove = new Set(names);
    return prev.filter((n) => !remove.has(n));
  });
}

const CATEGORY_ORDER = [
  "Memory", "Documents", "Files", "Shell", "Web", "Images", "Voice",
  "Schedule", "Atlassian", "GitHub", "Mail", "Calendar", "Config", "Other", "MCP",
];

function buildGroupedTools(tools: ToolInfo[]) {
  const byCat = new Map<string, ToolInfo[]>();
  const catGroup = new Map<string, string | null>();
  for (const t of tools) {
    const cat = t.category ?? "Other";
    const arr = byCat.get(cat) ?? [];
    arr.push(t);
    byCat.set(cat, arr);
    if (!catGroup.has(cat)) catGroup.set(cat, t.group ?? null);
  }
  const orderOf = (c: string) => {
    const i = CATEGORY_ORDER.indexOf(c);
    return i === -1 ? 999 : i;
  };
  const buckets = new Map<string | null, Array<[string, ToolInfo[]]>>();
  const groupOrder = new Map<string | null, number>();
  for (const [cat, ts] of byCat) {
    const g = catGroup.get(cat) ?? null;
    const arr = buckets.get(g) ?? [];
    arr.push([cat, ts]);
    buckets.set(g, arr);
    const prev = groupOrder.get(g);
    const here = orderOf(cat);
    if (prev === undefined || here < prev) groupOrder.set(g, here);
  }
  for (const arr of buckets.values()) arr.sort((a, b) => orderOf(a[0]) - orderOf(b[0]));
  for (const arr of buckets.values()) {
    for (const entry of arr) {
      entry[1].sort((a, b) => {
        const scoreDiff = (b.stats?.score ?? 0) - (a.stats?.score ?? 0);
        if (scoreDiff !== 0) return scoreDiff;
        return a.name.localeCompare(b.name);
      });
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => (groupOrder.get(a[0]) ?? 999) - (groupOrder.get(b[0]) ?? 999))
    .map(([group, categories]) => ({ group, categories }));
}
