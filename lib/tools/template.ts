/**
 * Tool creation template for Jarela (LangGraph/LangChain.js standard).
 *
 * To add a new tool:
 *   1. Copy this file to lib/tools/your-tool.ts
 *   2. Rename `myTool`, update name/description/schema, implement the function
 *   3. Append your export to ALL_TOOLS in lib/tools/index.ts
 *
 * Tools follow the LangChain StructuredTool convention:
 *   - Schema defined with Zod (auto-converted to JSON Schema for the LLM)
 *   - Function returns a JSON string (serialize result with JSON.stringify)
 *   - Throw an Error to signal failure — the agent receives the message as the result
 *   - Access thread_id via config?.configurable?.thread_id if needed
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";

export const myTool = tool(
  async (
    { input, options },
    _runManager?: unknown,
    config?: RunnableConfig,
  ) => {
    const trimmed = input.trim();
    if (!trimmed) throw new Error("input is required and must be non-empty");

    // Access thread context if needed:
    // const threadId = config?.configurable?.thread_id as string | undefined;
    void config; // remove this line once you use config

    // TODO: implement your logic here
    const result = { result: `Processed: ${trimmed}`, options };
    return JSON.stringify(result);
  },
  {
    name: "my_tool",
    description: "One-line description of what this tool does and when the agent should use it.",
    schema: z.object({
      input: z.string().describe("The main input for this tool."),
      options: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional configuration key/value pairs."),
    }),
  },
);
