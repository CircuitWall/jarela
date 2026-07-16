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

export const proposeConfigChangeTool = tool(
  async ({ kind, payload, reason }, config) => {
    const agentId = agentIdFromConfig(config);
    if (!agentId) return JSON.stringify({ error: "no agent context" });
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
      "The proposal is queued and shown to the user; they explicitly approve or deny. " +
      "Don't propose changes the user didn't ask for — only when the current task clearly needs it.",
    schema: z.object({
      kind: z
        .enum([
          "install_mcp",
          "toggle_mcp",
          "update_agent_tools",
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
          "- update_agent_tools: { agent_id: '<this-agent>', tools: ['web_search', 'memory_*'] }\n" +
          "- update_agent: { agent_id, identity?, instructions?, instructions_append?, history_limit?, history_window_hours?, harness_id? } " +
          "  — use instructions_append to add standing rules without overwriting existing ones (mutually exclusive with instructions); " +
          "  harness_id accepts an existing harness id ('builtin:default' or 'custom:<uuid>'), or null to inherit the global default\n" +
          "- start_oauth: { integration_id: 'gmail' } — only after enable_integration saved client_id/secret\n" +
          "- set_provider_key: { name: 'anthropic-default', provider: 'anthropic', model_id: 'claude-opus-4-7', is_default?: true } " +
          "  — the user pastes the API key into the approval modal; do NOT include it here\n" +
          "- enable_integration: { id: 'gmail' } — the user fills credentials in the approval modal\n" +
          "- upsert_harness: { id?: 'custom:<uuid>', name, description?, sections: { capabilities?: {enabled,body}, plan_first?: {enabled,body}, presentation?: {enabled,body}, citation?: {enabled,body}, self_config?: {enabled,body} } } " +
          "  — omit `id` to create; pass an existing custom:* id to edit. Built-in harnesses ('builtin:*') are read-only and rejected."
        ),
      reason: z.string().describe("Short human-readable reason shown to the user (≤100 chars)"),
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
