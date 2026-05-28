export const HARNESS_SECTION_KEYS = [
  "capabilities",
  "plan_first",
  "presentation",
  "citation",
  "self_config",
] as const;

export type HarnessSectionKey = typeof HARNESS_SECTION_KEYS[number];

export interface HarnessSection {
  enabled: boolean;
  body: string;
}

export interface Harness {
  id: string;
  name: string;
  description?: string;
  builtin: boolean;
  sections: Record<HarnessSectionKey, HarnessSection>;
}

export const BUILTIN_HARNESS_ID_PREFIX = "builtin:";
export const CUSTOM_HARNESS_ID_PREFIX = "custom:";
export const DEFAULT_HARNESS_ID = "builtin:default";

export function isBuiltinHarnessId(id: string): boolean {
  return id.startsWith(BUILTIN_HARNESS_ID_PREFIX);
}

export const SECTION_DISPLAY: Record<HarnessSectionKey, { title: string; hint: string }> = {
  capabilities: {
    title: "Host capabilities",
    hint: "What the surrounding app can do — notifications, scheduling, watchers, document indexing.",
  },
  plan_first: {
    title: "Plan-first acknowledgment",
    hint: "Acknowledge-before-acting rules, action principle, anti-fabrication, follow-through.",
  },
  presentation: {
    title: "Output formatting",
    hint: "Markdown / HTML extras, code fences, images, maps, citation refs block.",
  },
  citation: {
    title: "Source attribution",
    hint: "Anti-hallucination rules: every substantive claim must be tagged with its source.",
  },
  self_config: {
    title: "Self-configuration proposals",
    hint: "Lets the agent propose config changes (install MCP, edit agent, set keys) for user approval.",
  },
};
