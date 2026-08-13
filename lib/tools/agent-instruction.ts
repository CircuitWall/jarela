import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { registerLangChainPackage } from "./langchain-package";
import { getThread } from "@/lib/stores/threads";
import { getAgentConfig, getAgentTools, upsertAgentConfig } from "@/lib/stores/agent-configs";
import { applyInstructionEdits } from "@/lib/agents/instruction-edits";

function agentIdFromConfig(config?: RunnableConfig): string | null {
  const threadId = config?.configurable?.thread_id as string | undefined;
  if (!threadId) return null;
  return getThread(threadId)?.agent_id ?? null;
}

export const readAgentInstructionTool = tool(
  async ({ agent_id }, config) => {
    const currentAgentId = agentIdFromConfig(config);
    if (!currentAgentId) return JSON.stringify({ error: "no agent context" });

    if (agent_id && agent_id !== currentAgentId) {
      return JSON.stringify({
        error: "cross-agent instruction reads are not allowed; omit agent_id to read your own instruction",
      });
    }

    const cfg = getAgentConfig(currentAgentId);
    if (!cfg) return JSON.stringify({ error: `agent \"${currentAgentId}\" not found` });

    return JSON.stringify({
      agent_id: cfg.id,
      name: cfg.name,
      identity: cfg.identity,
      instructions: cfg.instructions,
      instruction_line_count: cfg.instructions ? cfg.instructions.split(/\r?\n/).length : 0,
      instruction_char_count: cfg.instructions.length,
    });
  },
  {
    name: "read_agent_instruction",
    description:
      "Read this agent's current persisted identity+instructions from config. " +
      "Use this before proposing instruction edits so replacements/dedupes are based on the real saved text.",
    schema: z.object({
      agent_id: z.string().optional().describe("Optional. Must match the current agent id when provided."),
    }),
  },
);

export const updateAgentInstructionTool = tool(
  async ({ agent_id, instructions, instructions_append, instructions_edits, dry_run }, config) => {
    const currentAgentId = agentIdFromConfig(config);
    if (!currentAgentId) return JSON.stringify({ error: "no agent context" });

    if (agent_id && agent_id !== currentAgentId) {
      return JSON.stringify({
        error: "cross-agent instruction updates are not allowed; omit agent_id to update your own instruction",
      });
    }

    const modeCount = [
      instructions !== undefined,
      instructions_append !== undefined,
      instructions_edits !== undefined,
    ].filter(Boolean).length;
    if (modeCount !== 1) {
      return JSON.stringify({
        error: "provide exactly one update mode: instructions OR instructions_append OR instructions_edits",
      });
    }

    const cfg = getAgentConfig(currentAgentId);
    if (!cfg) return JSON.stringify({ error: `agent \"${currentAgentId}\" not found` });

    let nextInstructions = cfg.instructions;
    let editSummary: Array<Record<string, unknown>> | undefined;
    if (instructions !== undefined) {
      nextInstructions = instructions;
    } else if (instructions_append !== undefined) {
      nextInstructions = cfg.instructions + instructions_append;
    } else if (instructions_edits !== undefined) {
      const transformed = applyInstructionEdits(cfg.instructions, instructions_edits);
      if (!transformed.ok) return JSON.stringify({ error: transformed.error });
      nextInstructions = transformed.text;
      editSummary = transformed.summary;
    }

    const changed = nextInstructions !== cfg.instructions;
    if (!dry_run) {
      upsertAgentConfig({
        id: cfg.id,
        name: cfg.name,
        icon: cfg.icon,
        identity: cfg.identity,
        instructions: nextInstructions,
        tools: getAgentTools(cfg),
        model_config_name: cfg.model_config_name,
        history_limit: cfg.history_limit,
        history_window_hours: cfg.history_window_hours,
        harness_id: cfg.harness_id,
      });
    }

    return JSON.stringify({
      agent_id: cfg.id,
      changed,
      dry_run: !!dry_run,
      before_char_count: cfg.instructions.length,
      after_char_count: nextInstructions.length,
      instructions: nextInstructions,
      edit_summary: editSummary,
      message: dry_run
        ? "Preview only; no instruction changes were persisted"
        : "Instruction updated successfully",
    });
  },
  {
    name: "update_agent_instruction",
    description:
      "Directly update this agent's own persisted instruction text without approval. " +
      "Supports full replace, append, or deterministic edit operations (replace/remove/dedupe). " +
      "This tool can only edit the current agent.",
    schema: z.object({
      agent_id: z.string().optional().describe("Optional. Must match the current agent id when provided."),
      instructions: z.string().optional().describe("Full replacement text for instructions."),
      instructions_append: z.string().optional().describe("Text appended to the end of the current instructions."),
      instructions_edits: z.array(z.record(z.string(), z.unknown())).optional().describe(
        "Deterministic edit operations over the current instruction text. " +
        "Ops: append|prepend|replace|remove|dedupe_lines|dedupe_paragraphs",
      ),
      dry_run: z.boolean().optional().describe("Preview changes without persisting."),
    }),
  },
);

registerLangChainPackage({
  category: "Config",
  tools: {
    read: [readAgentInstructionTool],
    write: [updateAgentInstructionTool],
  },
});
