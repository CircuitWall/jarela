// Executes a previously-approved pending action. Strictly server-side.
// Each `kind` maps to exactly one mutation site; nothing here touches the
// agent loop directly — approvals just write to the same tables the UI
// would touch, and the running agent picks up changes on its next turn.

import { getMcpServer, upsertMcpServer, type McpHttpSpec, type McpServerInput, type McpStdioSpec } from "@/lib/stores/mcp-servers";
import { invalidateMcpTools } from "@/lib/mcp/client";
import { applyVariables } from "@/lib/mcp/registry";
import { getUpstreamByName } from "@/lib/mcp/upstream-registry";
import { getAgentConfig, getAgentTools, upsertAgentConfig } from "@/lib/stores/agent-configs";
import type { ActionKind } from "@/lib/stores/pending-actions";
import { getManifest } from "@/lib/integrations/registry";
import { saveIntegration, INTEGRATIONS } from "@/lib/stores/integrations";
import { upsertModelConfig, getModelConfig } from "@/lib/stores/model-config";
import {
  createCustomHarness,
  getHarness,
  updateCustomHarness,
} from "@/lib/stores/harnesses";
import {
  CUSTOM_HARNESS_ID_PREFIX,
  HARNESS_SECTION_KEYS,
  isBuiltinHarnessId,
  type HarnessSection,
  type HarnessSectionKey,
} from "@/lib/agents/harness/types";
import { applyInstructionEdits } from "@/lib/agents/instruction-edits";
import { setCategoryEnabled } from "@/lib/stores/builtin-tools";
import { setDropinDisabled } from "@/lib/stores/disabled-dropin-tools";
import { BUILTIN_CATEGORIES, type BuiltinCategory } from "@/lib/tools/registry";

export interface ApplyResult {
  ok: boolean;
  detail: unknown;
}

// `extras` is approval-time material collected by the UI rather than sent
// in the original tool-call payload. ADR-0010 requires this for any action
// whose payload would otherwise carry a secret (set_provider_key, the
// credential fields of enable_integration). The agent never sees `extras`.
export async function applyAction(
  kind: ActionKind,
  payload: unknown,
  extras?: Record<string, unknown>,
): Promise<ApplyResult> {
  switch (kind) {
    case "install_mcp":        return await applyInstallMcp(payload);
    case "toggle_mcp":         return applyToggleMcp(payload);
    case "update_agent_tools": return applyUpdateAgentTools(payload);
    case "enable_tool_category": return applyEnableToolCategory(payload);
    case "enable_dropin_tool": return applyEnableDropinTool(payload);
    case "update_agent":       return applyUpdateAgent(payload);
    case "start_oauth":        return applyStartOauth(payload);
    case "set_provider_key":   return applySetProviderKey(payload, extras);
    case "enable_integration": return applyEnableIntegration(payload, extras);
    case "upsert_harness":     return applyUpsertHarness(payload);
    default:                   return { ok: false, detail: `unknown kind: ${kind}` };
  }
}

function applyEnableToolCategory(payload: unknown): ApplyResult {
  const p = payload as { category?: string };
  if (!p.category) return { ok: false, detail: "category required" };
  if (!(BUILTIN_CATEGORIES as readonly string[]).includes(p.category)) {
    return { ok: false, detail: `unknown built-in category: ${p.category}` };
  }
  setCategoryEnabled(p.category as BuiltinCategory, true);
  return { ok: true, detail: { category: p.category, enabled: true } };
}

function applyEnableDropinTool(payload: unknown): ApplyResult {
  const p = payload as { name?: string };
  if (!p.name) return { ok: false, detail: "name required" };
  setDropinDisabled(p.name, false);
  return { ok: true, detail: { name: p.name, enabled: true } };
}

async function applyInstallMcp(payload: unknown): Promise<ApplyResult> {
  const p = payload as { registry_id?: string; name?: string; spec?: Record<string, unknown>;
                        transport?: "stdio" | "http"; variables?: Record<string, string> };
  // Two install modes: from a registry entry (preferred) or full custom spec.
  if (p.registry_id) {
    // `registry_id` is the fully-qualified upstream name (e.g.
    // `io.github.github/github-mcp-server`). See ADR-0013.
    const entry = await getUpstreamByName(p.registry_id);
    if (!entry) return { ok: false, detail: `registry name "${p.registry_id}" not found in registry.modelcontextprotocol.io` };
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
  const p = payload as { agent_id?: string; tools?: string[]; mode?: "add" | "replace" };
  if (!p.agent_id || !Array.isArray(p.tools)) return { ok: false, detail: "agent_id and tools[] required" };
  const existing = getAgentConfig(p.agent_id);
  if (!existing) return { ok: false, detail: `agent "${p.agent_id}" not found` };
  const before = getAgentTools(existing);
  const mode = p.mode ?? "add";
  if (mode !== "add" && mode !== "replace") return { ok: false, detail: "mode must be add or replace" };
  const nextTools = mode === "replace"
    ? [...new Set(p.tools)]
    : [...new Set([...before, ...p.tools])];
  upsertAgentConfig({
    id: existing.id,
    name: existing.name,
    icon: existing.icon,
    identity: existing.identity,
    instructions: existing.instructions,
    tools: nextTools,
    model_config_name: existing.model_config_name,
  });
  return { ok: true, detail: { agent_id: p.agent_id, mode, before_tools: before, tools: nextTools, added_tools: nextTools.filter((t) => !before.includes(t)) } };
}

function applyUpdateAgent(payload: unknown): ApplyResult {
  const p = payload as {
    agent_id?: string;
    identity?: string;
    instructions?: string;
    instructions_append?: string;
    instructions_edits?: unknown;
    history_limit?: number;
    history_window_hours?: number;
    harness_id?: string | null;
  };
  if (!p.agent_id) return { ok: false, detail: "agent_id required" };
  const editModes = [
    p.instructions !== undefined,
    p.instructions_append !== undefined,
    p.instructions_edits !== undefined,
  ].filter(Boolean).length;
  if (editModes > 1) {
    return {
      ok: false,
      detail: "use one instructions mode only: instructions OR instructions_append OR instructions_edits",
    };
  }
  const existing = getAgentConfig(p.agent_id);
  if (!existing) return { ok: false, detail: `agent "${p.agent_id}" not found` };
  // ADR-0036: harness_id may now be set via update_agent. Validate the id
  // resolves before writing — upsertAgentConfig stores the value verbatim, so
  // a bad id would silently break the next agent run with "unknown harness".
  if (p.harness_id !== undefined && p.harness_id !== null && p.harness_id !== "") {
    if (!getHarness(p.harness_id)) {
      return { ok: false, detail: `harness "${p.harness_id}" not found` };
    }
  }
  const instructionsChanged =
    p.instructions !== undefined ||
    p.instructions_append !== undefined ||
    p.instructions_edits !== undefined;
  let newInstructions = existing.instructions;
  let instructionsEditSummary: Array<Record<string, unknown>> | undefined;
  if (p.instructions !== undefined) {
    newInstructions = p.instructions;
  } else if (p.instructions_append !== undefined) {
    newInstructions = existing.instructions + p.instructions_append;
  } else if (p.instructions_edits !== undefined) {
    const transformed = applyInstructionEdits(existing.instructions, p.instructions_edits);
    if (!transformed.ok) return { ok: false, detail: transformed.error };
    newInstructions = transformed.text;
    instructionsEditSummary = transformed.summary;
  }
  upsertAgentConfig({
    id: existing.id,
    name: existing.name,
    icon: existing.icon,
    identity: p.identity ?? existing.identity,
    instructions: newInstructions,
    tools: getAgentTools(existing),
    model_config_name: existing.model_config_name,
    history_limit: p.history_limit ?? existing.history_limit,
    history_window_hours: p.history_window_hours ?? existing.history_window_hours,
    harness_id: p.harness_id,
  });
  return {
    ok: true,
    detail: {
      agent_id: p.agent_id,
      identity_changed: p.identity !== undefined,
      instructions_changed: instructionsChanged,
      instructions_edit_summary: instructionsEditSummary,
      harness_id_changed: p.harness_id !== undefined,
    },
  };
}


// ADR-0036: agent-driven edits to *custom* harness presets. Built-ins remain
// read-only; the global default pointer stays UI-only. Creates when `id` is
// omitted; edits when `id` matches an existing custom harness.
function applyUpsertHarness(payload: unknown): ApplyResult {
  const p = payload as {
    id?: string;
    name?: string;
    description?: string;
    sections?: Partial<Record<HarnessSectionKey, Partial<HarnessSection>>>;
  };
  if (p.id && isBuiltinHarnessId(p.id)) {
    return { ok: false, detail: "built-in harnesses are read-only" };
  }
  const sections = p.sections ?? {};
  for (const k of Object.keys(sections)) {
    if (!HARNESS_SECTION_KEYS.includes(k as HarnessSectionKey)) {
      return { ok: false, detail: `unknown harness section: ${k}` };
    }
  }
  if (p.id && p.id.startsWith(CUSTOM_HARNESS_ID_PREFIX)) {
    const updated = updateCustomHarness(p.id, {
      name: p.name,
      description: p.description,
      sections: p.sections,
    });
    if (!updated) return { ok: false, detail: `custom harness "${p.id}" not found` };
    return { ok: true, detail: { id: updated.id, name: updated.name, created: false } };
  }
  if (p.id) {
    return { ok: false, detail: `harness id must start with "${CUSTOM_HARNESS_ID_PREFIX}" or be omitted` };
  }
  if (!p.name || !p.name.trim()) {
    return { ok: false, detail: "name required when creating a harness" };
  }
  const created = createCustomHarness({
    name: p.name,
    description: p.description,
    sections: p.sections ?? {},
  });
  return { ok: true, detail: { id: created.id, name: created.name, created: true } };
}

// ---------------------------------------------------------------------------
// ADR-0010: agent-led setup actions.
// ---------------------------------------------------------------------------

// `start_oauth` applies as a no-op on persistent state — the *real* effect is
// the browser following the authorize URL we return. The approval UI handles
// the redirect; the apply step exists only to convert the proposal into a
// concrete authorize_url tied to the integration's vendored scopes.
function applyStartOauth(payload: unknown): ApplyResult {
  const p = payload as { integration_id?: string };
  if (!p.integration_id) return { ok: false, detail: "integration_id required" };
  const manifest = getManifest(p.integration_id);
  if (!manifest) return { ok: false, detail: `unknown integration "${p.integration_id}"` };
  // The /api/v1/integrations/<id>/oauth/start endpoint already exists for
  // gmail and outlook and computes the URL from the saved client_id/secret.
  // Surface the relative path; the browser hits it after approval.
  return {
    ok: true,
    detail: {
      integration_id: manifest.id,
      kickoff_path: `/api/v1/integrations/${manifest.id}/oauth/start`,
      authorize_method: "POST",
    },
  };
}

// `set_provider_key` adds (or replaces) a model_configs row. The payload
// only declares which provider/model is being configured; the actual key
// arrives in `extras` from the approval secret-input modal. ADR-0010
// closes the prompt-injection vector this way: a malicious page cannot
// trick the agent into proposing an attacker key, because the agent never
// types or sees the key.
function applySetProviderKey(
  payload: unknown,
  extras?: Record<string, unknown>,
): ApplyResult {
  const p = payload as {
    name?: string;
    provider?: string;
    model_id?: string;
    is_default?: boolean;
  };
  if (!p.name || !p.provider || !p.model_id) {
    return { ok: false, detail: "name, provider, and model_id required" };
  }
  const apiKey = typeof extras?.api_key === "string" ? extras.api_key.trim() : "";
  if (!apiKey) {
    return {
      ok: false,
      detail: "api_key was not collected by the approval UI; nothing applied",
    };
  }
  const params: Record<string, unknown> = { api_key: apiKey };
  if (typeof extras?.base_url === "string" && extras.base_url.trim()) {
    params.base_url = extras.base_url.trim();
  }
  const isDefault = p.is_default ?? !getModelConfig(p.name);
  const row = upsertModelConfig(p.name, p.provider, p.model_id, params, isDefault);
  return {
    ok: true,
    detail: { name: row.name, provider: row.provider, model_id: row.model_id, is_default: !!row.is_default },
  };
}

// `enable_integration` saves credentials for one of the registered
// integrations and (implicitly) turns its tools on by virtue of the
// resolveAuth() helpers finding a record. Field values arrive in `extras`
// for the same reason as set_provider_key — secrets stay out of the agent
// payload.
function applyEnableIntegration(
  payload: unknown,
  extras?: Record<string, unknown>,
): ApplyResult {
  const p = payload as { id?: string };
  if (!p.id) return { ok: false, detail: "id required" };
  const manifest = getManifest(p.id);
  if (!manifest) return { ok: false, detail: `unknown integration "${p.id}"` };
  const def = (INTEGRATIONS as unknown as Record<string, { fields: ReadonlyArray<{ key: string }> } | undefined>)[p.id];
  if (!def) {
    return {
      ok: false,
      detail: `integration "${p.id}" has a manifest but no credentials schema in INTEGRATIONS — cannot enable`,
    };
  }
  // Pick only declared fields out of extras, ignore unknowns. Secrets are
  // strings; everything we declare is a string today.
  const incoming: Record<string, string> = {};
  for (const f of def.fields) {
    const v = extras?.[f.key];
    if (typeof v === "string") incoming[f.key] = v;
  }
  const result = saveIntegration(p.id, incoming);
  if ("error" in result) return { ok: false, detail: result.error };
  return { ok: true, detail: { id: p.id, configured: result.configured } };
}
