import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import { registerLangChainPackage } from "./langchain-package";
import { createPendingAction, getPendingAction } from "@/lib/stores/pending-actions";
import { getThread } from "@/lib/stores/threads";
import { publish as publishNotification } from "@/lib/notifications/bus";

function agentIdFromConfig(config?: RunnableConfig): string | null {
  const threadId = config?.configurable?.thread_id as string | undefined;
  if (!threadId) return null;
  return getThread(threadId)?.agent_id ?? null;
}

function validateProposalPayload(kind: string, payload: Record<string, unknown>): string | null {
  const hasString = (key: string) => typeof payload[key] === "string" && String(payload[key]).trim().length > 0;
  const hasObject = (key: string) => !!payload[key] && typeof payload[key] === "object" && !Array.isArray(payload[key]);

  if (kind === "install_mcp") {
    if (hasString("registry_id")) return null;
    if (hasString("name") && hasString("transport") && hasObject("spec")) return null;
    return "install_mcp requires registry_id or name + transport + spec";
  }
  if (kind === "toggle_mcp") {
    return hasString("name") && typeof payload.enabled === "boolean"
      ? null
      : "toggle_mcp requires name and enabled";
  }
  if (kind === "update_agent_tools") {
    return hasString("agent_id") && Array.isArray(payload.tools)
      ? null
      : "update_agent_tools requires agent_id and tools[]";
  }
  if (kind === "enable_tool_category") {
    return hasString("category") ? null : "enable_tool_category requires category";
  }
  if (kind === "enable_dropin_tool") {
    return hasString("name") ? null : "enable_dropin_tool requires name";
  }
  if (kind === "update_agent") {
    return hasString("agent_id") ? null : "update_agent requires agent_id";
  }
  if (kind === "start_oauth") {
    return hasString("integration_id") ? null : "start_oauth requires integration_id";
  }
  if (kind === "set_provider_key") {
    return hasString("name") && hasString("provider") && hasString("model_id")
      ? null
      : "set_provider_key requires name, provider, and model_id";
  }
  if (kind === "enable_integration") {
    return hasString("id") ? null : "enable_integration requires id";
  }
  if (kind === "upsert_harness") {
    return hasString("name") && hasObject("sections") ? null : "upsert_harness requires name and sections";
  }
  return null;
}

export const proposeConfigChangeTool = tool(
  async ({ kind, payload, reason }, config) => {
    const agentId = agentIdFromConfig(config);
    if (!agentId) return JSON.stringify({ error: "no agent context" });
    const validationError = validateProposalPayload(kind, payload);
    if (validationError) {
      return JSON.stringify({
        error: validationError,
        error_code: "invalid_proposal_payload",
        recovery_hint: "Call propose_config_change again with the required payload fields for this proposal kind.",
      });
    }
    const row = createPendingAction({ agent_id: agentId, kind, payload, reason });
    // Surface as a browser notification so the user notices even if not on this agent.
    publishNotification({
      type: "run_completed", // reuse channel; UI can branch on preview text
      thread_id: "",
      agent_id: agentId,
      status: "done",
      preview: `🛠️ Proposed config change (${kind}) — awaiting your approval`,
      ts: Date.now(),
    });
    return JSON.stringify({
      proposal_id: row.id,
      status: "pending",
      message:
        "Proposal queued for the user's approval. Tell the user briefly what you proposed and that " +
        "they need to approve it in the chat. Do not retry; check status later with check_proposal.",
    });
  },
  {
    name: "propose_config_change",
    description:
      "Propose a configuration change that requires user approval. Use this when you'd benefit from " +
      "installing/toggling an MCP server, or modifying agent settings (tool allowlist, identity, instructions, history window). " +
      "For this agent's own instruction-only updates, prefer update_agent_instruction (no approval). " +
      "The proposal is queued and shown to the user; they explicitly approve or deny. " +
      "Don't propose changes the user didn't ask for — only when the current task clearly needs it.",
    schema: z.object({
      kind: z
        .enum([
          "install_mcp",
          "toggle_mcp",
          "update_agent_tools",
          "enable_tool_category",
          "enable_dropin_tool",
          "update_agent",
          "start_oauth",
          "set_provider_key",
          "enable_integration",
          "upsert_harness",
        ])
        .describe("Type of change being proposed"),
      payload: z.record(z.string(), z.unknown())
        .describe(
          "Parameters for the change. NEVER put secrets, API keys, OAuth tokens, " +
          "or passwords in this object — those are collected by the approval UI " +
          "directly. Examples by kind:\n" +
          "- install_mcp: { registry_id: 'github', variables: { GITHUB_TOKEN: 'asks-user-for-it' } } " +
          "  OR { name, transport, spec }\n" +
          "- toggle_mcp: { name: 'github', enabled: true }\n" +
          "- update_agent_tools: { agent_id: '<this-agent>', tools: ['web_search', 'memory_*'], mode?: 'add'|'replace' } " +
          "— default mode is 'add' and merges tools into the existing allowlist; use mode='replace' only when the user explicitly asks to replace the full tool list\n" +
          "- enable_tool_category: { category: 'Web' } — only when list_tools shows a globally disabled built-in category is required\n" +
          "- enable_dropin_tool: { name: 'custom_tool_name' } — only when list_tools shows a globally disabled drop-in tool is required\n" +
          "- update_agent: { agent_id, identity?, instructions?, instructions_append?, history_limit?, history_window_hours?, harness_id? } " +
          "  — use instructions_append to add standing rules without overwriting existing ones; " +
          "  use instructions_edits for deterministic transforms over the current saved instruction text " +
          "(mutually exclusive with instructions/instructions_append). " +
          "instructions_edits supports: " +
          "[{ op: 'replace', find, replace, all?, ignore_case? }, { op: 'remove', text, all?, ignore_case? }, " +
          "{ op: 'append'|'prepend', text, if_missing?, ignore_case? }, { op: 'dedupe_lines'|'dedupe_paragraphs', keep?: 'first'|'last' }]. " +
          "  harness_id accepts an existing harness id ('builtin:default' or 'custom:<uuid>'), or null to inherit the global default\n" +
          "- start_oauth: { integration_id: 'gmail' } — only after enable_integration saved client_id/secret\n" +
          "- set_provider_key: { name: 'anthropic-default', provider: 'anthropic', model_id: 'claude-opus-4-7', is_default?: true } " +
          "  — the user pastes the API key into the approval modal; do NOT include it here\n" +
          "- enable_integration: { id: 'gmail' } — the user fills credentials in the approval modal\n" +
          "- upsert_harness: { id?: 'custom:<uuid>', name, description?, sections: { capabilities?: {enabled,body}, plan_first?: {enabled,body}, presentation?: {enabled,body}, citation?: {enabled,body}, self_config?: {enabled,body} } } " +
          "  — omit `id` to create; pass an existing custom:* id to edit. Built-in harnesses ('builtin:*') are read-only and rejected."
        ),
      reason: z.string().min(1).max(100).describe("Short human-readable reason shown to the user (≤100 chars)"),
    }),
  },
);

export const checkProposalTool = tool(
  async ({ proposal_id }) => {
    const row = getPendingAction(proposal_id);
    if (!row) return JSON.stringify({ error: `proposal ${proposal_id} not found` });
    return JSON.stringify({
      id: row.id,
      kind: row.kind,
      status: row.status,
      result: row.result ? safeParse(row.result) : null,
      created_at: row.created_at,
      decided_at: row.decided_at,
    });
  },
  {
    name: "check_proposal",
    description: "Check the status of a previously-submitted config-change proposal by its id.",
    schema: z.object({
      proposal_id: z.string(),
    }),
  },
);

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

registerLangChainPackage({
  category: "Config",
  tools: {
    read: [checkProposalTool],
    write: [proposeConfigChangeTool],
  },
});
