// Tool-error introspection for the agent stream pipeline.
//
// Tools surface failures in three shapes today:
//   - PR-4 ToolResult union:  {kind: "error", code, message, data?}
//   - Legacy envelope:        {error: "...", code?: "..."}  (atlassian.ts, github.ts, fetch.ts pre-PR-B)
//   - Plain throw caught by dispatch → normalised to {kind:"error", code:"tool_threw", message}
//
// `extractToolError` reads any of these and returns a stable
// `{code, message}` pair the stream emitter can promote to the
// `tool_result` chunk's first-class fields (so the LLM and the chat UI
// can branch on the code without parsing the payload). Returns null on
// success-shaped payloads.
//
// Lives outside lib/tools/* on purpose — it's consumed by the agent stream
// (lib/agents/llm.ts) which must not pull in the full tools registry.

export interface ToolErrorInfo {
  code: string;
  message: string;
  /**
   * ADR-0056 — domain-specific recovery hint provided by the tool. Optional.
   * The system-prompt playbook handles generic rules ("don't retry timeouts
   * blindly"); the tool itself contributes the recovery path that only it
   * knows ("call jira_list_projects to discover valid keys").
   */
  hint?: string;
}

export function extractToolError(payload: unknown): ToolErrorInfo | null {
  if (!payload || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;

  // PR-4 ToolResult union shape: {kind:"error", code, message, hint?}
  if (o.kind === "error") {
    const code = typeof o.code === "string" && o.code ? o.code : "tool_error";
    const message = typeof o.message === "string" ? o.message : "Tool returned an error.";
    const hint = typeof o.hint === "string" && o.hint ? o.hint : undefined;
    return hint ? { code, message, hint } : { code, message };
  }

  // Legacy envelope: {error: "...", code?, hint?}
  if ("error" in o) {
    const errVal = o.error;
    const message = typeof errVal === "string" ? errVal : JSON.stringify(errVal);
    const code = typeof o.code === "string" && o.code ? o.code : "tool_error";
    const hint = typeof o.hint === "string" && o.hint ? o.hint : undefined;
    return hint ? { code, message, hint } : { code, message };
  }

  return null;
}
