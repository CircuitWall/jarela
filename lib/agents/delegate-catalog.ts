import { getAgentConfig, parseDelegateTargets, type AgentConfigRow } from "@/lib/stores/agent-configs";
import type { ToolCatalogEntry } from "@/lib/tools";
import { advertisementService } from "./advertisement-service";

export const DELEGATE_CATALOG_MAX_CHARS = 12000;
export const DELEGATE_CATALOG_MAX_TARGETS = 32;
export async function buildDelegateCatalog(
  agent: Pick<AgentConfigRow, "id" | "delegate_targets">,
  permissions: readonly Pick<ToolCatalogEntry, "name" | "permission" | "permission_reason">[],
  _catalog: readonly ToolCatalogEntry[],
): Promise<string[]> {
  if (!permissions.some((tool) => tool.name === "delegate_to_agent"
    && (tool.permission === "enabled" || tool.permission_reason === "proxy_only"))) return [];
  const targets = parseDelegateTargets(agent.delegate_targets).filter((id) => id !== agent.id)
    .map(getAgentConfig).filter((target): target is AgentConfigRow => target !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!targets.length) return [];
  if (targets.length > DELEGATE_CATALOG_MAX_TARGETS) {
    return ["Delegate catalog overflow: more than 32 authorized targets. Narrow the roster in agent settings; no targets were silently selected."];
  }
  const legacy = targets.map((target) => JSON.stringify({
    id: target.id, name: target.name.slice(0, 80), provenance: "legacy", specialization: "No current generated specialization",
  }));
  const generated: string[] = [];
  for (let i = 0; i < targets.length; i++) {
    try {
      const state = await advertisementService().inspect(targets[i].id);
      generated.push(state?.status === "ready" && state.advertisement
        ? JSON.stringify({ id: targets[i].id, name: targets[i].name.slice(0, 80), provenance: "model-generated, not verified", ...state.advertisement })
        : legacy[i]);
    } catch {
      console.warn("[advertisements] catalog metadata unavailable; using authorized legacy identity only");
      generated.push(JSON.stringify({ id: targets[i].id, name: targets[i].name.slice(0, 80), provenance: "legacy", specialization: "Metadata unavailable; inspect advertisement settings" }));
    }
  }
  if (generated.join("\n").length <= DELEGATE_CATALOG_MAX_CHARS) return generated;
  const fallback = ["Generated specializations omitted: catalog exceeded its 12000-character limit. All authorized identities follow as legacy metadata.", ...legacy];
  if (fallback.join("\n").length <= DELEGATE_CATALOG_MAX_CHARS) return fallback;
  return ["Delegate catalog overflow: authorized identity data exceeds the limit. Narrow the roster; no targets were silently selected."];
}
