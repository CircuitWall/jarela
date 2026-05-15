// Executes a previously-approved pending action. Strictly server-side.
// Each `kind` maps to exactly one mutation site; nothing here touches the
// agent loop directly — approvals just write to the same tables the UI
// would touch, and the running agent picks up changes on its next turn.

import { getMcpServer, upsertMcpServer, type McpHttpSpec, type McpServerInput, type McpStdioSpec } from "@/lib/stores/mcp-servers";
import { invalidateMcpTools } from "@/lib/mcp/client";
import { applyVariables, MCP_REGISTRY } from "@/lib/mcp/registry";
import { getAgentConfig, upsertAgentConfig } from "@/lib/stores/agent-configs";
import type { ActionKind } from "@/lib/stores/pending-actions";

export interface ApplyResult {
  ok: boolean;
  detail: unknown;
}

export async function applyAction(kind: ActionKind, payload: unknown): Promise<ApplyResult> {
  switch (kind) {
    case "install_mcp":      return await applyInstallMcp(payload);
    case "toggle_mcp":       return applyToggleMcp(payload);
    case "update_agent_tools": return applyUpdateAgentTools(payload);
    case "update_agent":     return applyUpdateAgent(payload);
    default:                 return { ok: false, detail: `unknown kind: ${kind}` };
  }
}

async function applyInstallMcp(payload: unknown): Promise<ApplyResult> {
  const p = payload as { registry_id?: string; name?: string; spec?: Record<string, unknown>;
                        transport?: "stdio" | "http"; variables?: Record<string, string> };
  // Two install modes: from a registry entry (preferred) or full custom spec.
  if (p.registry_id) {
    const entry = MCP_REGISTRY.find((e) => e.id === p.registry_id);
    if (!entry) return { ok: false, detail: `registry id "${p.registry_id}" not found` };
    const missing = (entry.variables ?? []).filter((v) => !p.variables?.[v.key]?.toString().trim());
    if (missing.length > 0) {
      return { ok: false, detail: `missing variables: ${missing.map((m) => m.key).join(", ")}` };
    }
    const spec = applyVariables(entry.spec, p.variables ?? {});
    const name = (p.name ?? entry.id).trim();
    upsertMcpServer({ name, transport: entry.transport, spec: spec as unknown as McpStdioSpec | McpHttpSpec, enabled: true });
    invalidateMcpTools();
    return { ok: true, detail: { name, registry_id: p.registry_id } };
  }
  if (p.name && p.spec && p.transport) {
    upsertMcpServer({
      name: p.name,
      transport: p.transport,
      spec: p.spec as unknown as McpStdioSpec | McpHttpSpec,
      enabled: true,
    } satisfies McpServerInput);
    invalidateMcpTools();
    return { ok: true, detail: { name: p.name } };
  }
  return { ok: false, detail: "install_mcp needs either registry_id+variables, or name+transport+spec" };
}

function applyToggleMcp(payload: unknown): ApplyResult {
  const p = payload as { name?: string; enabled?: boolean };
  if (!p.name || typeof p.enabled !== "boolean") return { ok: false, detail: "name and enabled required" };
  const existing = getMcpServer(p.name);
  if (!existing) return { ok: false, detail: `mcp server "${p.name}" not found` };
  upsertMcpServer({
    name: existing.name,
    transport: existing.transport as "stdio" | "http",
    spec: JSON.parse(existing.spec) as McpStdioSpec | McpHttpSpec,
    enabled: p.enabled,
  });
  invalidateMcpTools();
  return { ok: true, detail: { name: p.name, enabled: p.enabled } };
}

function applyUpdateAgentTools(payload: unknown): ApplyResult {
  const p = payload as { agent_id?: string; tools?: string[] };
  if (!p.agent_id || !Array.isArray(p.tools)) return { ok: false, detail: "agent_id and tools[] required" };
  const existing = getAgentConfig(p.agent_id);
  if (!existing) return { ok: false, detail: `agent "${p.agent_id}" not found` };
  upsertAgentConfig({
    id: existing.id,
    name: existing.name,
    icon: existing.icon,
    identity: existing.identity,
    instructions: existing.instructions,
    tools: p.tools,
    model_config_name: existing.model_config_name,
  });
  return { ok: true, detail: { agent_id: p.agent_id, tools: p.tools } };
}

function applyUpdateAgent(payload: unknown): ApplyResult {
  const p = payload as {
    agent_id?: string;
    identity?: string;
    instructions?: string;
    history_limit?: number;
    history_window_hours?: number;
  };
  if (!p.agent_id) return { ok: false, detail: "agent_id required" };
  const existing = getAgentConfig(p.agent_id);
  if (!existing) return { ok: false, detail: `agent "${p.agent_id}" not found` };
  upsertAgentConfig({
    id: existing.id,
    name: existing.name,
    icon: existing.icon,
    identity: p.identity ?? existing.identity,
    instructions: p.instructions ?? existing.instructions,
    tools: JSON.parse(existing.tools) as string[],
    model_config_name: existing.model_config_name,
    history_limit: p.history_limit ?? existing.history_limit,
    history_window_hours: p.history_window_hours ?? existing.history_window_hours,
  });
  return {
    ok: true,
    detail: {
      agent_id: p.agent_id,
      identity_changed: p.identity !== undefined,
      instructions_changed: p.instructions !== undefined,
    },
  };
}
