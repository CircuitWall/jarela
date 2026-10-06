// Built-in tools that pair with wallclock result references.
//
// `async_run: true` on any tool returns immediately with a key; the
// agent later calls these tools to retrieve the result.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerLangChainPackage } from "../packages/langchain-package";
import {
  consumeAsyncResult,
  getAsyncResult,
  listAsyncResults,
  type AsyncResultRecord,
} from "./async-results";
import { parseToolResultReferenceEnvelope, readToolResultRef, getToolResultMaxBytes } from "./result-refs";
import { BACKGROUND_RESULT_REF_PREFIX, backgroundResultReference, readBackgroundResultReference } from "@/lib/stores/background-results";

function serialize(rec: AsyncResultRecord, includeResult: boolean, maxEncodedBytes = getToolResultMaxBytes()): Record<string, unknown> {
  const out: Record<string, unknown> = {
    key: rec.key,
    tool: rec.tool,
    status: rec.status,
    started_at: rec.started_at,
    finished_at: rec.finished_at,
    elapsed_ms: (rec.finished_at ?? Date.now()) - rec.started_at,
  };
  const terminalContents = rec.status === "done" ? rec.result : rec.status === "error" ? rec.error : null;
  if (includeResult && rec.status === "done") {
    const refEnvelope = rec.owner_thread_id ? null : parseToolResultReferenceEnvelope(rec.result);
    if (refEnvelope) Object.assign(out, refEnvelope);
    else out.result = rec.result;
  }
  if (includeResult && rec.status === "error") out.error = rec.error;
  if (includeResult && rec.owner_thread_id && terminalContents !== null
    && Buffer.byteLength(JSON.stringify({ ok: true, ...out })) > maxEncodedBytes) {
    delete out.result;
    delete out.error;
    const name = backgroundResultReference(rec.key);
    Object.assign(out, { truncated: true, bytes: Buffer.byteLength(terminalContents),
      result_ref: { name, uri: name, mimeType: "text/plain", size: Buffer.byteLength(terminalContents) },
      hint: "Read encrypted output with result_ref.name. Consume on the final page to remove it." });
  }
  return out;
}

async function waitForFinish(key: string, waitMs: number, threadId?: string): Promise<AsyncResultRecord | null> {
  const deadline = Date.now() + Math.max(0, waitMs);
  // 50ms poll — cheap on a Map.get, and bounded by waitMs.
  while (Date.now() < deadline) {
    const rec = getAsyncResult(key, threadId);
    if (!rec) return null;
    if (rec.status !== "pending") return rec;
    await new Promise((r) => setTimeout(r, 50));
  }
  return getAsyncResult(key, threadId);
}

export const toolResultGetTool = tool(
  async ({ key, result_ref, name, offset, limit, wait_ms, consume }, config) => {
    const owner = config?.configurable?.thread_id;
    const threadId = typeof owner === "string" ? owner : undefined;
    const configuredBudget = config?.configurable?.tool_result_max_bytes;
    const maxEncodedBytes = typeof configuredBudget === "number" && Number.isFinite(configuredBudget)
      ? Math.max(1, Math.min(getToolResultMaxBytes(), Math.floor(configuredBudget))) : getToolResultMaxBytes();
    const refName = result_ref?.name ?? name;
    if (refName) {
      if (refName.startsWith(BACKGROUND_RESULT_REF_PREFIX)) {
        const page = readBackgroundResultReference(refName, threadId, offset, limit, consume, maxEncodedBytes);
        if (consume && page.ok === true && page.done === true) consumeAsyncResult(refName.slice(BACKGROUND_RESULT_REF_PREFIX.length), threadId);
        return JSON.stringify(page);
      }
      if (!result_ref?.name) {
        console.warn(
          `[tool_result_get] deprecated flat "name" argument used instead of "result_ref: { name }"; ` +
          "accepting it for now, but callers should switch to the nested shape.",
        );
      }
      return JSON.stringify(await readToolResultRef({ name: refName, offset, limit }));
    }
    if (!key) {
      return JSON.stringify({ ok: false, status: "unknown", error: "pass either key or result_ref.name" });
    }
    let rec: AsyncResultRecord | null = getAsyncResult(key, threadId);
    if (!rec) {
      return JSON.stringify({
        ok: false,
        status: "unknown",
        key,
        error: "no async result for that key (it may have expired or never existed)",
      });
    }
    if (rec.status === "pending" && typeof wait_ms === "number" && wait_ms > 0) {
      rec = (await waitForFinish(key, wait_ms, threadId)) ?? rec;
    }
    if (!rec) {
      return JSON.stringify({ ok: false, status: "unknown", key });
    }
    const finished = rec.status !== "pending";
    const response = { ok: true, ...serialize(rec, /* includeResult */ true, maxEncodedBytes) };
    if (consume && finished && !(rec.owner_thread_id && "result_ref" in response)) {
      consumeAsyncResult(key, threadId);
    }
    return JSON.stringify(response);
  },
  {
    name: "tool_result_get",
    description:
      "Retrieve the result of a previously async-fired tool call by its key. " +
      "Also reads result_ref payloads by result_ref.name with offset/limit. Owned background output stays encrypted and thread-scoped; protected pages are bounded by the inline output budget. " +
      "Pass `wait_ms` to short-poll up to that long for a pending call to finish. " +
      "Pass `consume: true` to delete a finished inline result, or on the final protected page to delete a paged result. " +
      "Status will be 'pending' (still running), 'done' (success — `result` populated), " +
      "'error' (failed — `error` populated), or 'unknown' (no such key).",
    schema: z.object({
      key: z.string().optional().describe("The key returned by the original async tool call."),
      wait_ms: z
        .number()
        .int()
        .min(0)
        .max(60_000)
        .optional()
        .describe("Optional short-poll budget (0–60000 ms). Returns as soon as the call finishes or the budget elapses."),
      consume: z
        .boolean()
        .optional()
        .describe("If true and the call has finished, delete the entry after returning it. Default false."),
      result_ref: z.object({
        name: z.string().describe("The result_ref.name returned by a truncated tool result."),
      }).optional().describe("Read a spilled tool result by reference instead of an async key."),
      name: z
        .string()
        .optional()
        .describe("Deprecated: use result_ref.name instead. Flat shorthand for result_ref: { name }, accepted for now."),
      offset: z.number().int().min(0).optional().describe("Byte offset when reading a spilled result_ref."),
      limit: z.number().int().min(1).max(1024 * 1024).optional().describe("Maximum bytes to read from a spilled result_ref."),
    }),
  },
);

export const toolResultListTool = tool(
  async ({ status }, config) => {
    const owner = config?.configurable?.thread_id;
    let recs = listAsyncResults(typeof owner === "string" ? owner : undefined);
    if (status) recs = recs.filter((r) => r.status === status);
    return JSON.stringify({
      ok: true,
      count: recs.length,
      // Lightweight summary only — full result/error stays behind tool_result_get.
      results: recs.map((r) => serialize(r, /* includeResult */ false)),
    });
  },
  {
    name: "tool_result_list",
    description:
      "List currently tracked async tool results (newest first). Useful when you've forgotten " +
      "a key or want a quick status check across pending background calls. Optional `status` " +
      "filter narrows to 'pending' / 'done' / 'error'.",
    schema: z.object({
      status: z.enum(["pending", "done", "error"]).optional()
        .describe("Optional status filter."),
    }),
  },
);

registerLangChainPackage({
  category: "Agent",
  tools: { read: [toolResultGetTool, toolResultListTool] },
});
