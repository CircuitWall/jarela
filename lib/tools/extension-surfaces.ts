// Meta-introspection: a hand-curated catalog of every place a third party
// (or the agent itself, on behalf of the user) can extend or customize the
// app. Read-only. The tool returns a structured map that points to the
// registration entrypoint, the integration guide section, and an example
// file for each surface — so the agent can answer "how do I add an X?"
// or "what can be customized" without needing the docs in its context.
//
// SOURCE OF TRUTH: this file. When a new extension surface lands, add an
// entry below — it's a single source for both the agent runtime and the
// `docs/EXTENDING.md` table-of-contents anchor.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerTools } from "./registry";

interface ExtensionSurface {
  id: string;
  name: string;
  summary: string;
  registration_entrypoint: string;
  doc_section: string;
  example_path?: string;
  introspection_tool?: string;
  related_adrs: string[];
}

const SURFACES: readonly ExtensionSurface[] = [
  {
    id: "llm_provider_builtin",
    name: "Built-in LLM provider",
    summary:
      "Add a new in-tree adapter (Anthropic, OpenAI, Gemini, … pattern). " +
      "Implements the ModelProvider interface and is registered via the static " +
      "BUILTINS map in lib/providers/index.ts.",
    registration_entrypoint: "lib/providers/index.ts (BUILTINS map)",
    doc_section: "docs/EXTENDING.md#adding-an-llm-provider-built-in",
    example_path: "lib/providers/anthropic.ts",
    introspection_tool: "list_providers",
    related_adrs: ["ADR-0013"],
  },
  {
    id: "llm_provider_external",
    name: "External LLM provider plugin",
    summary:
      "Drop a `.cjs` plugin into ~/.jarela/providers/ that exports an object " +
      "matching ModelProvider. Hot-loaded per call (no rebuild).",
    registration_entrypoint: "~/.jarela/providers/<name>.cjs",
    doc_section: "docs/EXTENDING.md#adding-an-llm-provider-external",
    example_path: "lib/providers/template-external.cjs.example",
    introspection_tool: "list_providers",
    related_adrs: ["ADR-0013"],
  },
  {
    id: "builtin_tool",
    name: "Built-in tool",
    summary:
      "Add a tool callable by the agent. Implement with @langchain/core/tools, " +
      "register with `registerTools(category, capability, [tool])`, and add a " +
      "side-effect import in lib/tools/builtins.ts. Capability gating is " +
      "read | write | execute.",
    registration_entrypoint: "lib/tools/<name>.ts (registerTools call) + lib/tools/builtins.ts",
    doc_section: "docs/EXTENDING.md#adding-a-built-in-tool",
    example_path: "lib/tools/template.ts",
    introspection_tool: "list_tools",
    related_adrs: ["ADR-0038"],
  },
  {
    id: "mcp_server",
    name: "MCP server",
    summary:
      "Connect a Model Context Protocol server (stdio or http transport). " +
      "Configured via the UI (mcp_servers DB table) or programmatically through " +
      "lib/stores/mcp-servers.ts. Tools auto-merge into the same pool as " +
      "built-ins. Online discovery via the MCP registry is also supported.",
    registration_entrypoint: "lib/stores/mcp-servers.ts (upsertMcpServer)",
    doc_section: "docs/EXTENDING.md#adding-an-mcp-server",
    introspection_tool: "list_mcp_servers",
    related_adrs: ["ADR-0014"],
  },
  {
    id: "agent_harness",
    name: "Agent harness",
    summary:
      "Compose system-prompt sections that shape an agent's behaviour " +
      "(plan-first, self-config, capability-listing, etc.). Built-in presets " +
      "live in lib/agents/harness/presets.ts; custom harnesses are stored in " +
      "the memory_store under the `app-settings` namespace.",
    registration_entrypoint: "lib/agents/harness/presets.ts (built-in) or memory_store (custom)",
    doc_section: "docs/EXTENDING.md#adding-a-custom-harness",
    related_adrs: ["ADR-0036"],
  },
  {
    id: "integration_manifest",
    name: "Integration manifest",
    summary:
      "Add a new agent-led setup recipe — prerequisites, ordered steps, " +
      "troubleshooting hints. The agent narrates the recipe and proposes " +
      "the corresponding config changes through propose_config_change.",
    registration_entrypoint: "lib/integrations/registry.ts",
    doc_section: "docs/EXTENDING.md#adding-an-integration-manifest",
    introspection_tool: "list_integrations",
    related_adrs: ["ADR-0010"],
  },
  {
    id: "brand_overlay",
    name: "Brand / app identity",
    summary:
      "Customize the app's name, description, and issue URL via environment " +
      "variables. No code change required. Used by downstream packages that " +
      "consume @circuitwall/jarela as an npm dep (e.g. brand overlays).",
    registration_entrypoint: "NEXT_PUBLIC_APP_NAME, NEXT_PUBLIC_APP_DESCRIPTION, NEXT_PUBLIC_APP_ISSUE_URL",
    doc_section: "docs/EXTENDING.md#branding-the-app",
    related_adrs: ["ADR-0005"],
  },
];

export const describeExtensionSurfacesTool = tool(
  async () => {
    return JSON.stringify({
      surfaces: SURFACES,
      count: SURFACES.length,
      guide_path: "docs/EXTENDING.md",
      contract_paths: [
        "lib/providers/types.ts (ModelProvider interface)",
        "lib/tools/types.ts (OpenAITool, ToolContext, InvokeMessage)",
        "lib/tools/registry.ts (registerTools, ToolCategory, Capability)",
        "lib/mcp/registry.ts (RegistryEntry, applyVariables)",
      ],
      notes: [
        "Each surface's introspection_tool, when set, lets you enumerate what's " +
          "currently registered. Call those when the user asks 'what's available' " +
          "rather than describing the type from memory.",
        "A surface can have either a static example_path (for external plugins) or " +
          "no example (for surfaces wired entirely through the UI / DB). When in " +
          "doubt, the doc_section under EXTENDING.md is the canonical walk-through.",
      ],
    });
  },
  {
    name: "describe_extension_surfaces",
    description:
      "Return the curated catalog of every extension surface in this app — " +
      "providers, tools, MCP servers, harnesses, integration manifests, brand " +
      "overlay. Each entry has a registration entrypoint, an EXTENDING.md " +
      "section anchor, and (when applicable) the introspection tool that lists " +
      "what's currently registered. Read-only. Call this when the user asks " +
      "'how do I add an X?' or 'what can be customized?' so you can guide " +
      "them with the right files and docs.",
    schema: z.object({}),
  },
);

registerTools("Config", "read", [describeExtensionSurfacesTool]);
