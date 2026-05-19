// Integration manifest contract — see ADR-0010.
//
// Every directory under lib/integrations/ must export a `manifest` from
// `manifest.ts` matching this schema. The manifest is the single source of
// truth for both the agent's setup guidance and the static Integrations
// panel. A lint check (scripts/check-integration-manifests.mjs) enforces
// presence at build time.

import { z } from "zod";
import type { ActionKind } from "@/lib/stores/pending-actions";

export const PrerequisiteSchema = z.object({
  check: z.enum(["provider_key", "oauth_app", "env", "credentials", "custom"]),
  detail: z.string().min(1),
  docs_url: z.string().url().optional(),
});

export const SetupStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  // Which propose_config_change kind (if any) implements this step.
  // When unset, the step is purely instructional (e.g. "create an Azure app
  // registration in the Azure portal" — no Jarela-side mutation).
  proposes: z
    .enum([
      "install_mcp",
      "toggle_mcp",
      "update_agent_tools",
      "update_agent",
      "start_oauth",
      "set_provider_key",
      "enable_integration",
    ])
    .optional(),
  // Optional self-test the agent can run after the step completes.
  verify: z
    .object({
      tool: z.string(),
      args: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  docs_url: z.string().url().optional(),
});

export const TroubleshootingSchema = z.object({
  when: z.string().min(1),
  say: z.string().min(1),
});

export const IntegrationManifestSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, "id must be lowercase kebab-case"),
  name: z.string().min(1),
  summary: z.string().min(1),
  category: z.enum(["llm", "mail", "calendar", "issue-tracker", "chat", "infrastructure", "other"]),
  prerequisites: z.array(PrerequisiteSchema),
  steps: z.array(SetupStepSchema).min(1),
  troubleshooting: z.array(TroubleshootingSchema),
});

export type Prerequisite = z.infer<typeof PrerequisiteSchema>;
export type SetupStep = z.infer<typeof SetupStepSchema>;
export type Troubleshooting = z.infer<typeof TroubleshootingSchema>;

export interface IntegrationManifest {
  id: string;
  name: string;
  summary: string;
  category: "llm" | "mail" | "calendar" | "issue-tracker" | "chat" | "infrastructure" | "other";
  prerequisites: Prerequisite[];
  steps: Array<Omit<SetupStep, "proposes"> & { proposes?: ActionKind }>;
  troubleshooting: Troubleshooting[];
}

export function validateManifest(m: unknown): IntegrationManifest {
  return IntegrationManifestSchema.parse(m) as IntegrationManifest;
}
