import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerLangChainPackage } from "../packages/langchain-package";
import { moveThreadContextBoundary } from "@/lib/agents/context-boundary";
import { getRecentMessagesWindow } from "@/lib/stores/threads";

const RECENT_ROWS_SCANNED = 20;

export const compactContextTool = tool(
  async (_input, config) => {
    const threadId = config?.configurable?.thread_id as string | undefined;
    if (!threadId) return JSON.stringify({ ok: false, error: "no thread context" });

    const lastUser = getRecentMessagesWindow(threadId, RECENT_ROWS_SCANNED, undefined, "all")
      .filter((m) => m.role === "user")
      .at(-1);
    if (!lastUser) return JSON.stringify({ ok: false, error: "no user message to anchor the boundary" });
    // Bridge conversations keep their own scoped history and are never compacted here.
    if (lastUser.category != null) {
      return JSON.stringify({ ok: false, error: "not available for this conversation type" });
    }

    // The current user message stays hot; everything before it becomes the warm summary.
    moveThreadContextBoundary(threadId, lastUser.seq, { refreshWarmSummary: true });
    return JSON.stringify({
      ok: true,
      status: "scheduled",
      note: "Earlier messages are being summarized in the background. This turn is unaffected; continue with the user's new request.",
    });
  },
  {
    name: "compact_context",
    description:
      "Summarize and fold the earlier conversation out of the hot context so the next turns start fresh. " +
      "Call it only when the user has explicitly said they do NOT want to continue the earlier conversation " +
      "(after a Conversation gap prompt). Never call it when the user continues the earlier topic or when you are unsure.",
    schema: z.object({}),
  },
);

registerLangChainPackage({
  category: "Agent",
  tools: { write: [compactContextTool] },
});
