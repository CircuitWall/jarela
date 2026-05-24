// Persona → integration-category filter.
//
// The Credentials panel is overwhelming on first boot because *every*
// integration is shown to every user. Most home users do not need Jira,
// most work users do not need a personal LLM key separate from the
// chat-bot keys, and a casual chat user does not want to see GitHub /
// infrastructure tokens at all.
//
// We let the user pick a single "preset" in the Profile editor and use
// it to filter the Credentials list. Picking "custom" (or leaving it
// unset → null) shows everything — exactly today's behaviour.
//
// This mapping is intentionally small and conservative: a "home" user
// still gets LLM keys (otherwise nothing works), and a "work" user
// still gets mail/calendar/issue-tracker/infrastructure (today's
// office toolbelt). "dev" sees everything, same as "custom".

import type { IntegrationCategory } from "@/lib/stores/integrations";
import type { UserPreset } from "@/lib/stores/user-profile";

export const PRESET_CATEGORIES: Record<UserPreset, ReadonlySet<IntegrationCategory> | null> = {
  home: new Set<IntegrationCategory>(["llm", "mail", "calendar", "chat", "other"]),
  work: new Set<IntegrationCategory>(["llm", "mail", "calendar", "issue-tracker", "infrastructure", "other"]),
  dev: null,    // null = show all
  custom: null, // null = show all
};

/** Returns true when the given integration category should be visible for the given preset. */
export function isCategoryVisible(
  preset: UserPreset | null | undefined,
  category: IntegrationCategory | undefined,
): boolean {
  if (!preset) return true;            // unset → show all
  const allowed = PRESET_CATEGORIES[preset];
  if (allowed === null) return true;   // dev / custom → show all
  if (!category) return true;          // legacy entries without category → show
  return allowed.has(category);
}
