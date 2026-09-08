export const BASIC_TOOL_CATEGORIES = [
  "Memory",
  "Documents",
  "Files",
  "Shell",
  "Schedule",
  "Config",
  "Agent",
  "Skills",
  "Web",
] as const;

const BASIC_TOOL_CATEGORY_SET = new Set<string>(BASIC_TOOL_CATEGORIES);

export function normalizeToolCategory(category: string | null | undefined): string {
  const trimmed = category?.trim();
  return trimmed ? trimmed : "Other";
}

export function isBasicToolCategory(category: string | null | undefined): boolean {
  return BASIC_TOOL_CATEGORY_SET.has(normalizeToolCategory(category));
}