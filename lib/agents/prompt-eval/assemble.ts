/**
 * Builds the exact system prompt a scenario's agent would receive, plus the
 * tool permission map that produced it.
 *
 * This is the same construction path production uses
 * (`applyAgentPermissionsToCatalog` -> `markProxyOnlyTools` -> `buildSystemPrompt`),
 * so a scenario assertion fails for the reason a real turn would fail.
 *
 * Callers must set `JARELA_DB_DIR` to a scratch directory before importing this
 * module, matching `lib/agents/prompt-variants.ts`.
 */
import type { ToolCatalogEntry } from "@/lib/tools";
import { getAllToolCatalogAsync, applyAgentPermissionsToCatalog, markProxyOnlyTools } from "@/lib/tools";
import { buildSystemPrompt } from "@/lib/agents/prepare/system-prompt";
import { agentCfg, budget } from "@/lib/agents/prompt-variants";
import type { PromptScenario } from "./types";

export interface ScenarioPrompt {
  prompt: string;
  /** Full permission map the prompt renders. */
  permissionMap: ToolCatalogEntry[];
  /** Tools this agent can execute directly this turn. */
  boundTools: string[];
  /** Tools that exist but are gated, with the reason the prompt must explain. */
  gatedTools: Array<{ name: string; reason: string | null }>;
}

export async function buildScenarioPrompt(scenario: PromptScenario): Promise<ScenarioPrompt> {
  const catalog = await getAllToolCatalogAsync();
  const cfg = agentCfg({
    id: `prompt-eval-${scenario.id}`,
    name: `Prompt eval ${scenario.id}`,
    instructions: "",
    tools: JSON.stringify(scenario.agentTools),
  });

  const permissions = applyAgentPermissionsToCatalog(catalog, cfg);
  const enabled = permissions.filter((entry) => entry.permission === "enabled").map((entry) => entry.name);
  // A narrowed surface (pin list or provider cap) leaves the rest proxy_only.
  const bound = scenario.bindOnly.length > 0
    ? enabled.filter((name) => scenario.bindOnly.includes(name))
    : enabled;
  // Bind every executable tool: the point of the scenario is that the model has
  // to choose the right one, not that the wrong ones are hidden.
  const permissionMap = markProxyOnlyTools(permissions, bound, enabled);

  const prompt = buildSystemPrompt({
    agentCfg: cfg,
    trimmedMessage: scenario.request,
    budget,
    recallCtx: "",
    warmSummaryCtx: "",
    factsCtx: "",
    experienceMode: "full",
    delegateRosterLines: [],
    allowedTools: bound,
    toolPermissionMap: permissionMap,
  });

  return {
    prompt,
    permissionMap,
    boundTools: bound,
    gatedTools: permissions
      .filter((entry) => entry.permission !== "enabled")
      .map((entry) => ({ name: entry.name, reason: entry.permission_reason ?? null })),
  };
}

/** Tool names rendered in the prompt's `--- Enabled tools ---` list. */
export function listedToolNames(prompt: string): string[] {
  const section = prompt.split("--- Enabled tools ---")[1]?.split("\n\n")[0] ?? "";
  return section
    .split("\n")
    .map((line) => /^- [^>]+ > [^>]+ > ([a-zA-Z0-9_]+): /.exec(line)?.[1])
    .filter((name): name is string => typeof name === "string");
}
