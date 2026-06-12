// Browser-control command queue. The agent-side tools in
// `lib/tools/browser-control.ts` enqueue a command here; the browser
// extension long-polls `/api/v1/extension/browser/poll` to pick one up,
// executes it in the user's active tab, then POSTs the outcome to
// `/api/v1/extension/browser/result` which resolves the awaiting tool.
//
// Single in-process queue — the single-Next.js-process invariant from
// CLAUDE.md means we never need cross-process coordination. All state is
// ephemeral; a server restart aborts any in-flight commands cleanly
// (the agent tool rejects with "server restarted").
//
// All routes are loopback-only (same posture as the rest of
// `/api/v1/extension/*` and `/api/v1/page-capture`): on a default
// 127.0.0.1 bind a malicious site cannot reach them, so the extension
// channel does not need a separate shared secret. Operators who bind to
// a network interface should run Jarela behind tailscale / a reverse
// proxy as the README already documents.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { isLoopbackRequest } from "@/lib/auth/access";

// Soft cap on the number of commands sitting in the queue at once.
// A runaway LLM that fires hundreds of click() calls in one turn would
// otherwise just bloat memory; 32 leaves headroom for legitimate
// multi-step flows while staying well below ridiculous.
export const MAX_QUEUE_DEPTH = 32;

// Per-command absolute ceiling. Even when the LLM passes a longer
// timeout_ms the queue won't keep the request pending past this.
// Matches the upper end of the per-route SSE timeouts used elsewhere
// in the app.
export const MAX_COMMAND_TIMEOUT_MS = 120_000;

// Default per-command timeout — generous for slow page loads, tight
// enough that a stuck extension can't pin a turn for a full minute.
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

// How long the poll endpoint will hold its connection open waiting for
// a command. Chosen so a typical idle service-worker reconnect cycle
// (the SW gets killed at ~30s) does not abort an active poll.
export const POLL_WAIT_MS = 25_000;

// --------------------------------------------------------------------- //
// Command / result type contracts (shared with the extension via JSON)  //
// --------------------------------------------------------------------- //

export const ScrollTo = z.enum(["top", "bottom", "into-view"]);
export const ScreenshotFormat = z.enum(["png", "jpeg"]);
export const ExtractFormat = z.enum(["text", "html", "outerHTML"]);

const NavigateCommandShape = z.object({
  type: z.literal("navigate"),
  url: z.string().url(),
  wait_for_selector: z.string().min(1).max(2000).optional(),
});
const ClickCommandShape = z.object({
  type: z.literal("click"),
  selector: z.string().min(1).max(2000),
});
const FillCommandShape = z.object({
  type: z.literal("fill"),
  selector: z.string().min(1).max(2000),
  value: z.string().max(50_000),
  submit: z.boolean().optional(),
});
const ScrollCommandShape = z.object({
  type: z.literal("scroll"),
  selector: z.string().min(1).max(2000).optional(),
  to: ScrollTo,
});
const ScreenshotCommandShape = z.object({
  type: z.literal("screenshot"),
  selector: z.string().min(1).max(2000).optional(),
  format: ScreenshotFormat.default("png"),
  full_page: z.boolean().optional(),
});
const ExtractCommandShape = z.object({
  type: z.literal("extract"),
  selector: z.string().min(1).max(2000).optional(),
  format: ExtractFormat.default("text"),
  max_chars: z.number().int().positive().max(200_000).optional(),
});

const CommandShape = z.discriminatedUnion("type", [
  NavigateCommandShape,
  ClickCommandShape,
  FillCommandShape,
  ScrollCommandShape,
  ScreenshotCommandShape,
  ExtractCommandShape,
]);

export type BrowserCommandPayload = z.infer<typeof CommandShape>;
export type BrowserCommand = BrowserCommandPayload & {
  cmd_id: string;
  timeout_ms: number;
  enqueued_at: number;
};

const ResultBodyShape = z.object({
  cmd_id: z.string().min(1).max(128),
  ok: z.boolean(),
  // Free-form result data — each command type returns its own shape.
  // The agent tool stringifies whatever lands here, so we deliberately
  // keep this loose; per-type assertions happen tool-side.
  data: z.unknown().optional(),
  error: z.string().max(4000).optional(),
});

export type BrowserResult =
  | { cmd_id: string; ok: true; data: unknown }
  | { cmd_id: string; ok: false; error: string };

// --------------------------------------------------------------------- //
// In-memory queue                                                       //
// --------------------------------------------------------------------- //

interface PendingEntry {
  command: BrowserCommand;
  resolve: (r: BrowserResult) => void;
  // Hard-deadline timer; clears the entry and rejects the agent tool
  // when fired. Cleared in submitResult / dequeueForPoll when picked.
  expiry: ReturnType<typeof setTimeout>;
  // Whether a poller has already picked this command. We don't remove
  // it from the queue map at that point so a late /result POST can
  // still resolve the agent tool.
  picked: boolean;
}

// Ordered list: FIFO dispatch order. Map keyed by cmd_id for O(1)
// result lookup. Both reference the same `PendingEntry` objects.
const queue: PendingEntry[] = [];
const byId = new Map<string, PendingEntry>();

// Waiters on the poll side. Resolved either when a command lands
// (`enqueueInternal`) or when the long-poll wait timer fires.
const pollWaiters: Array<(c: BrowserCommand | null) => void> = [];

function findUnpicked(): PendingEntry | null {
  for (const e of queue) if (!e.picked) return e;
  return null;
}

function dispatchToNextWaiter(): void {
  if (pollWaiters.length === 0) return;
  const e = findUnpicked();
  if (!e) return;
  e.picked = true;
  const waiter = pollWaiters.shift()!;
  waiter(e.command);
}

function removeEntry(cmdId: string): void {
  const idx = queue.findIndex((e) => e.command.cmd_id === cmdId);
  if (idx >= 0) queue.splice(idx, 1);
  byId.delete(cmdId);
}

/**
 * Enqueue a browser command and return a promise that resolves with the
 * extension's outcome (or rejects with an error). Caller decides the
 * per-command timeout; clamped to MAX_COMMAND_TIMEOUT_MS on the high end.
 */
export function enqueueCommand(
  payload: BrowserCommandPayload,
  opts?: { timeout_ms?: number },
): { cmd_id: string; promise: Promise<BrowserResult> } {
  if (queue.length >= MAX_QUEUE_DEPTH) {
    return {
      cmd_id: "",
      promise: Promise.resolve({
        cmd_id: "",
        ok: false,
        error: `browser command queue full (>${MAX_QUEUE_DEPTH} pending). Wait for prior commands to finish, or check that the Jarela browser extension is connected.`,
      }),
    };
  }
  const cmd_id = randomUUID();
  const requested = Math.max(1_000, Math.min(MAX_COMMAND_TIMEOUT_MS, opts?.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS));
  const command: BrowserCommand = {
    cmd_id,
    timeout_ms: requested,
    enqueued_at: Date.now(),
    ...payload,
  };
  let resolveOuter!: (r: BrowserResult) => void;
  const promise = new Promise<BrowserResult>((res) => { resolveOuter = res; });
  const expiry = setTimeout(() => {
    if (byId.has(cmd_id)) {
      removeEntry(cmd_id);
      resolveOuter({
        cmd_id,
        ok: false,
        error: `command timed out after ${requested}ms. Is the Jarela browser extension installed and connected?`,
      });
    }
  }, requested);
  const entry: PendingEntry = { command, resolve: resolveOuter, expiry, picked: false };
  queue.push(entry);
  byId.set(cmd_id, entry);
  // Wake any waiting poller.
  dispatchToNextWaiter();
  return { cmd_id, promise };
}

/**
 * Block until a command is available, or the poll-wait window elapses.
 * Resolves with `null` on idle expiry so the extension can immediately
 * re-poll without any error path.
 */
export function pollNextCommand(waitMs: number = POLL_WAIT_MS): Promise<BrowserCommand | null> {
  const e = findUnpicked();
  if (e) {
    e.picked = true;
    return Promise.resolve(e.command);
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: BrowserCommand | null) => {
      if (settled) return;
      settled = true;
      const idx = pollWaiters.indexOf(wrapped);
      if (idx >= 0) pollWaiters.splice(idx, 1);
      resolve(v);
    };
    const wrapped = (c: BrowserCommand | null) => settle(c);
    pollWaiters.push(wrapped);
    setTimeout(() => settle(null), Math.max(100, waitMs));
  });
}

/**
 * Deliver an extension-side outcome back to the awaiting agent tool.
 * No-op when the cmd_id is unknown — the agent may have already timed
 * out, or the extension may be replaying a result after a server restart.
 */
export function submitResult(result: BrowserResult): { matched: boolean } {
  const entry = byId.get(result.cmd_id);
  if (!entry) return { matched: false };
  clearTimeout(entry.expiry);
  removeEntry(result.cmd_id);
  entry.resolve(result);
  return { matched: true };
}

/** @internal — test-only: drop every pending command and wake pollers with null. */
export function _resetQueue(): void {
  for (const e of queue) {
    clearTimeout(e.expiry);
    e.resolve({ cmd_id: e.command.cmd_id, ok: false, error: "queue reset" });
  }
  queue.length = 0;
  byId.clear();
  while (pollWaiters.length > 0) {
    const w = pollWaiters.shift()!;
    w(null);
  }
}

/** @internal — test-only: how many commands are currently buffered. */
export function _queueDepth(): number {
  return queue.length;
}

// --------------------------------------------------------------------- //
// HTTP handlers                                                         //
// --------------------------------------------------------------------- //

function loopbackForbidden(): Response {
  return new Response(JSON.stringify({ error: "loopback only" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

function badRequest(msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

export async function handleBrowserPoll(req: Request): Promise<Response> {
  if (!isLoopbackRequest(req)) return loopbackForbidden();
  // Honor the client's wait_ms but cap at POLL_WAIT_MS so a misbehaving
  // caller can't pin a Next.js worker indefinitely.
  let waitMs = POLL_WAIT_MS;
  if (req.method === "POST") {
    try {
      const raw = (await req.json()) as { wait_ms?: unknown };
      if (typeof raw?.wait_ms === "number" && raw.wait_ms > 0) {
        waitMs = Math.min(POLL_WAIT_MS, raw.wait_ms);
      }
    } catch {
      // Empty / non-JSON body → use default. Extension is permitted to
      // send GET; treat both shapes identically.
    }
  }
  const cmd = await pollNextCommand(waitMs);
  if (!cmd) {
    return new Response(JSON.stringify({ ok: true, command: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ ok: true, command: cmd }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export async function handleBrowserResult(req: Request): Promise<Response> {
  if (!isLoopbackRequest(req)) return loopbackForbidden();
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  const parsed = ResultBodyShape.safeParse(raw);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "invalid result body");
  }
  const body = parsed.data;
  const result: BrowserResult = body.ok
    ? { cmd_id: body.cmd_id, ok: true, data: body.data ?? null }
    : { cmd_id: body.cmd_id, ok: false, error: body.error ?? "unspecified extension error" };
  const { matched } = submitResult(result);
  return new Response(JSON.stringify({ ok: true, matched }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** @internal — exported for the agent-side tool layer; do not import elsewhere. */
export { CommandShape as _CommandShape };
