// Read-only tools that expose integration manifests to the agent. See
// ADR-0010 — these power the "user asks how to connect X → agent narrates
// the steps and proposes actions" loop without giving the agent any new
// privileges.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getManifest, listManifests } from "@/lib/integrations/registry";
import { getIntegrationStatus, isKnownIntegration } from "@/lib/stores/integrations";

function manifestStatus(id: string): "configured" | "not_configured" | "no_credentials_schema" {
  if (!isKnownIntegration(id)) return "no_credentials_schema";
  return getIntegrationStatus(id)?.configured ? "configured" : "not_configured";
}

export const listIntegrationsTool = tool(
  async () => {
    const summary = listManifests().map((m) => ({
      id: m.id,
      name: m.name,
      category: m.category,
      summary: m.summary,
      status: manifestStatus(m.id),
    }));
    return JSON.stringify({ integrations: summary });
  },
  {
    name: "list_integrations",
    description:
      "List every integration Jarela knows how to set up, with a one-line summary and " +
      "current configuration status. Read-only. Use this when the user asks 'what can I connect?' " +
      "or before proposing enable_integration, so you know what's available and whether it's " +
      "already configured.",
    schema: z.object({}),
  },
);

export const getIntegrationSetupTool = tool(
  async ({ id }) => {
    const manifest = getManifest(id);
    if (!manifest) {
      return JSON.stringify({
        error: `unknown integration "${id}". Call list_integrations to see available ids.`,
      });
    }
    return JSON.stringify({
      id: manifest.id,
      name: manifest.name,
      summary: manifest.summary,
      category: manifest.category,
      status: manifestStatus(manifest.id),
      prerequisites: manifest.prerequisites,
      steps: manifest.steps,
      troubleshooting: manifest.troubleshooting,
      notes: [
        "Walk the user through `prerequisites` first; some require browser actions outside Jarela.",
        "For each step that has a `proposes` field, call propose_config_change with that kind when ready.",
        "When a step has a `verify.tool`, call that tool after applying the step to confirm success.",
      ],
    });
  },
  {
    name: "get_integration_setup",
    description:
      "Return the full setup manifest for one integration — prerequisites, ordered steps, and " +
      "troubleshooting hints. Read-only. Use this before walking the user through a setup, or " +
      "when a tool fails and you need the integration-specific recovery hint.",
    schema: z.object({
      id: z.string().describe("Integration id from list_integrations (e.g. 'gmail', 'atlassian')"),
    }),
  },
);
