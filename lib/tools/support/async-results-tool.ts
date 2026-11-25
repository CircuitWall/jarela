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
  readAsyncProgress,
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
    progress_bytes: rec.progress_bytes,
    last_output_at: rec.last_output_at,
    exit_code: rec.exit_code,
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

/**
 * Wait for a pending call to settle — or, when the caller is following from a
 * cursor, for any new output past it. `cursor: Infinity` means "settle only",
 * which is the original wait-for-completion behaviour.
 */
async function waitForFinish(
  key: string,
  waitMs: number,
  threadId: string | undefined,
  cursor = Number.POSITIVE_INFINITY,
): Promise<AsyncResultRecord | null> {
  const deadline = Date.now() + Math.max(0, waitMs);
  // 50ms poll — cheap on a Map.get, and bounded by waitMs.
  while (Date.now() < deadline) {
    const rec = getAsyncResult(key, threadId);
    if (!rec) return null;
    if (rec.status !== "pending" || rec.progress_bytes > cursor) return rec;
    await new Promise((r) => setTimeout(r, 50));
  }
  return getAsyncResult(key, threadId);
}

export const toolResultGetTool = tool(
  async ({ key, result_ref, name, offset, limit, wait_ms, consume, cursor }, config) => {
    const owner = config?.configurable?.thread_id;
    const threadId = typeof owner === "string" ? owner : undefined;
    const configuredBudget = config?.configurable?.tool_result_max_bytes;
    const maxEncodedBytes = typeof configuredBudget === "number" && Number.isFinite(configuredBudget)
      ? Math.max(1, Math.min(getToolResultMaxBytes(), Math.floor(configuredBudget))) : getToolResultMaxBytes();
    const requestedRef = (result_ref?.name ?? name)?.trim() ?? "";
    // Following from a cursor is an explicit "show me what changed" request;
    // it is what makes wait_ms return on new output instead of only on
    // completion.
    const following = typeof cursor === "number" && Number.isFinite(cursor) && cursor >= 0;
    const cursorFrom = following ? Math.max(0, Math.floor(cursor as number)) : 0;
    const progressBytes = Math.min(limit ?? 8 * 1024, 64 * 1024);
    // A copied async key is the same result as the key argument; reading it as
    // a file name would report a correct id as missing.
    const refIsKey = /^async_[0-9a-f]{16}$/.test(requestedRef);
    const refName = refIsKey ? "" : requestedRef;
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
    const resolvedKey = key?.trim() || (refIsKey ? requestedRef : "");
    if (!resolvedKey) {
      return JSON.stringify({ ok: false, status: "unknown", error: "pass either key or result_ref.name" });
    }
    let rec: AsyncResultRecord | null = getAsyncResult(resolvedKey, threadId);
    if (!rec) {
      return JSON.stringify({
        ok: false,
        status: "unknown",
        key: resolvedKey,
        error: "no async result for that key (it may have expired or never existed)",
      });
    }
    if (rec.status === "pending" && typeof wait_ms === "number" && wait_ms > 0) {
      rec = (await waitForFinish(resolvedKey, wait_ms, threadId, following ? cursorFrom : Number.POSITIVE_INFINITY)) ?? rec;
    }
    if (!rec) {
      return JSON.stringify({ ok: false, status: "unknown", key: resolvedKey });
    }
    const finished = rec.status !== "pending";
    const response: Record<string, unknown> = { ok: true, ...serialize(rec, /* includeResult */ true, maxEncodedBytes) };
    // Progress is the point of following a running call: return what changed
    // since the caller's cursor while it is still pending, and let a finished
    // call be paged the same way when a cursor was asked for.
    if (rec.progress_bytes > 0 && (following || !finished)) {
      const page = readAsyncProgress(resolvedKey, cursorFrom, progressBytes, threadId);
      if (page) {
        response.progress = page;
        if (page.dropped_bytes > 0) {
          response.progress_note =
            `${page.dropped_bytes} byte(s) scrolled out of the live window before cursor ${cursorFrom}; ` +
            `resumed at ${page.offset}. Read the full log from log_path with file_grep/file_read.`;
        }
        if (rec.log_path) response.log_path = rec.log_path;
        if (!finished) {
          response.hint =
            "Still running. Call again with cursor=progress.next_offset to read only new output, or pass wait_ms " +
            "to wait for more. Arm schedule_wakeup instead of polling in a loop when the wait is long.";
        }
      }
    }
    if (consume && finished && !(rec.owner_thread_id && "result_ref" in response)) {
      consumeAsyncResult(resolvedKey, threadId);
    }
    return JSON.stringify(response);
  },
  {
    name: "tool_result_get",
    description:
      "Retrieve a background call's output by its key, or read a spilled result_ref payload. " +
      "Background keys come from `async_run: true` and from calls moved to the background at their deadline. " +
      "While a call is still pending it returns `progress` — the output produced so far — so you can follow a long " +
      "task without blocking the conversation. Pass `cursor` with the previous response's progress.next_offset to " +
      "receive only what changed; combined with `wait_ms` that returns as soon as new output arrives. " +
      "The full output log is at `log_path` (use file_grep/file_read for history older than the bounded window). " +
      "For result_ref payloads, read by the full result_ref.name (including extension, not sha256) with offset/limit. Unambiguous legacy content hashes are accepted for text/JSON spills. Owned background output stays encrypted and thread-scoped; protected pages are bounded by the inline output budget. " +
      "For spilled file_read output, prefer file_grep and a bounded line-ranged file_read on the source. Read only a needed result slice with a small limit; do not exhaust pages unless the task requires complete inspection. " +
      "Pass `wait_ms` without `cursor` to wait for a pending call to finish. " +
      "Pass `consume: true` to delete a finished inline result, or on the final protected page to delete a paged result. " +
      "Status will be 'pending' (still running), 'done' (success — `result` populated), " +
      "'error' (failed — `error` populated), 'unknown' (missing key/reference), or 'ambiguous' (a hash matches multiple files; pass the full reference name).",
    schema: z.object({
      key: z.string().optional().describe("The key returned by the original async tool call."),
      wait_ms: z
        .number()
        .int()
        .min(0)
        .max(60_000)
        .optional()
        .describe("Optional poll budget (0–60000 ms). Without `cursor` it waits for the call to finish; with `cursor` it also returns as soon as new output arrives."),
      cursor: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Byte cursor for following a running call's output. Pass the previous response's progress.next_offset " +
          "to get only new output. Omit to read progress from the start (and wait only for completion).",
        ),
      consume: z
        .boolean()
        .optional()
        .describe("If true and the call has finished, delete the entry after returning it. Default false."),
      result_ref: z.object({
        name: z.string().describe("The full result_ref.name returned by a truncated tool result, including its file extension. Do not substitute sha256. The result_ref.uri and absolute path forms are accepted too."),
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
      "List currently tracked background calls (newest first) — the ones started with async_run and the ones moved " +
      "to the background at their deadline. Each row carries status, elapsed time, progress_bytes, last_output_at " +
      "and exit_code, so you can tell a call that is producing output from one that is stalled. Use it when you " +
      "have forgotten a key. Synchronous spilled results are read directly by result_ref.name and are not tracked " +
      "here. Optional `status` filter narrows to 'pending' / 'done' / 'error'.",
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
