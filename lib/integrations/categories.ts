// Persona → integration-category filter.
//
// The Credentials panel is overwhelming on first boot because *every*
// integration is shown to every user. Most home users do not need Jira,
// most work users do not need a personal LLM key separate from the
// chat-bot keys, and a casual chat user does not want to see GitHub /
// infrastructure tokens at all.
//
// Each agent's usage profile selects a discovery filter. "custom"
// (Everything) leaves the catalog unfiltered. Saved credentials remain
// visible independently of discovery.
//
// This mapping is intentionally small and conservative: a "home" user
// still gets LLM keys (otherwise nothing works), and a "work" user
// still gets mail/calendar/issue-tracker/infrastructure (today's
// office toolbelt). "dev" sees everything, same as "custom".

import type { IntegrationCategory } from "@/lib/stores/integrations";
import type { UsageProfile } from "@/lib/agents/usage-profile";
import type { IntegrationDefinition, IntegrationStatus } from "@/api/types";

export const PRESET_CATEGORIES: Record<UsageProfile, ReadonlySet<IntegrationCategory> | null> = {
  home: new Set<IntegrationCategory>(["llm", "mail", "calendar", "chat", "other"]),
  work: new Set<IntegrationCategory>(["llm", "mail", "calendar", "issue-tracker", "infrastructure", "other"]),
  dev: null,    // null = show all
  custom: null, // null = show all
};

export function filterIntegrationsForProfile(
  definitions: IntegrationDefinition[],
  statuses: Record<string, IntegrationStatus>,
  profile: UsageProfile,
): IntegrationDefinition[] {
  const allowed = PRESET_CATEGORIES[profile];
  return allowed === null ? definitions : definitions.filter((definition) =>
    !definition.category || allowed.has(definition.category) || statuses[definition.name]?.configured === true,
  );
}
