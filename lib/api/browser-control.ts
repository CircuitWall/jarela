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
import {
  completeBrowserCommandLog,
  createBrowserCommandLog,
  getBrowserCommandLog,
  listBrowserCommandLogs,
  markBrowserCommandRunning,
  markBrowserCommandProgress,
} from "@/lib/stores/browser-command-log";
import { clearForegroundTabPresence, setForegroundTabPresence } from "@/lib/api/foreground-presence";
import { isAmbientContextEnabled } from "@/lib/stores/app-settings";

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

// Grace window for "is the extension currently connected". A healthy
// extension long-polls every ~25s; if more than this has elapsed since
// the last poll AND no poller is currently parked, the SW is almost
// certainly dead (MV3 killed it, browser quit, network blip) and any
// command we enqueue will just sit there until it times out. The fast
// path in `enqueueCommand` rejects immediately instead — the agent gets
// a clean "extension not connected" error in <1s rather than waiting
// the full per-command timeout (30s default).
//
// Slightly larger than POLL_WAIT_MS so a healthy extension that's mid
// long-poll-recycle doesn't get flagged as offline.
export const EXTENSION_LIVENESS_WINDOW_MS = 35_000;

// --------------------------------------------------------------------- //
// Command / result type contracts (shared with the extension via JSON)  //
// --------------------------------------------------------------------- //

export const ScrollTo = z.enum(["top", "bottom", "into-view"]);
export const ScreenshotFormat = z.enum(["png", "jpeg"]);
export const ExtractFormat = z.enum(["text", "html", "outerHTML"]);

// `auto_snapshot` instructs the extension to take a page snapshot after
// a successful state-changing action and ship it back in the result. The
// agent-side tool wrapper uses that snapshot to update its locator cache
// and emit a diff to the LLM, eliminating the explicit follow-up
// `browser_snapshot` call on every step.
const NavigateCommandShape = z.object({
  type: z.literal("navigate"),
  url: z.string().url(),
  wait_for_selector: z.string().min(1).max(2000).optional(),
  auto_snapshot: z.boolean().optional(),
});
const ClickCommandShape = z.object({
  type: z.literal("click"),
  selector: z.string().min(1).max(2000),
  auto_snapshot: z.boolean().optional(),
});
const FillCommandShape = z.object({
  type: z.literal("fill"),
  selector: z.string().min(1).max(2000),
  value: z.string().max(50_000),
  submit: z.boolean().optional(),
  auto_snapshot: z.boolean().optional(),
});
const FillManyCommandShape = z.object({
  type: z.literal("fill_many"),
  fields: z
    .array(z.object({
      selector: z.string().min(1).max(2000),
      value: z.string().max(50_000),
    }))
    .min(1)
    .max(25),
  submit_selector: z.string().min(1).max(2000).optional(),
  auto_snapshot: z.boolean().optional(),
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
  offset: z.number().int().min(0).optional(),
});

const SnapshotCommandShape = z.object({
  type: z.literal("snapshot"),
  max_items: z.number().int().positive().max(300).optional(),
  include_hidden: z.boolean().optional(),
});

const TabsCommandShape = z.object({
  type: z.literal("tabs"),
  include_unusable: z.boolean().optional(),
});

const ActivateTabCommandShape = z.object({
  type: z.literal("activate_tab"),
  tab_id: z.number().int().positive(),
});

const BooleanQueryShape = z.enum(["true", "false"]).transform((value) => value === "true");

const BrowserTabsQueryShape = z.object({
  include_unusable: BooleanQueryShape.optional(),
  timeout_ms: z.coerce.number().int().positive().max(MAX_COMMAND_TIMEOUT_MS).optional(),
});

const BrowserActivateBodyShape = z.object({
  tab_id: z.number().int().positive(),
  timeout_ms: z.number().int().positive().max(MAX_COMMAND_TIMEOUT_MS).optional(),
});

const BrowserHistoryQueryShape = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const BrowserRetryBodyShape = z.object({
  cmd_id: z.string().min(1).max(128),
  timeout_ms: z.number().int().positive().max(MAX_COMMAND_TIMEOUT_MS).optional(),
});

const BrowserProgressBodyShape = z.object({
  cmd_id: z.string().min(1).max(128),
  phase: z.string().min(1).max(80),
});

const BrowserForegroundBodyShape = z.object({
  url: z.string().url().max(4000),
  title: z.string().max(500).optional(),
  host: z.string().max(300).optional(),
  tab_id: z.number().int().positive().optional(),
  recorded_at: z.number().int().nonnegative().optional(),
});

const CommandShape = z.discriminatedUnion("type", [
  NavigateCommandShape,
  ClickCommandShape,
  FillCommandShape,
  FillManyCommandShape,
  ScrollCommandShape,
  ScreenshotCommandShape,
  ExtractCommandShape,
  SnapshotCommandShape,
  TabsCommandShape,
  ActivateTabCommandShape,
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
  pickedAt: number | null;
}

// Ordered list: FIFO dispatch order. Map keyed by cmd_id for O(1)
// result lookup. Both reference the same `PendingEntry` objects.
const queue: PendingEntry[] = [];
const byId = new Map<string, PendingEntry>();

// Waiters on the poll side. Resolved either when a command lands
// (`enqueueInternal`) or when the long-poll wait timer fires.
const pollWaiters: Array<(c: BrowserCommand | null) => void> = [];

// --------------------------------------------------------------------- //
// Extension connectivity tracking                                       //
// --------------------------------------------------------------------- //
// Updated every time the extension hits `/poll`; the enqueue path and
// the `/status` endpoint read it to fast-fail commands when the
// extension is offline instead of waiting for the per-command timeout.

let lastPollAt = 0;
let pollerWaiting = 0;

export interface ExtensionStatus {
  connected: boolean;
  pollerWaiting: number;
  lastSeenMs: number;            // ms since the last `/poll` hit, or -1 if never
  pendingCommands: number;
  liveness_window_ms: number;
}

export function getExtensionStatus(): ExtensionStatus {
  const sinceLast = lastPollAt === 0 ? -1 : Date.now() - lastPollAt;
  const connected = pollerWaiting > 0 || (sinceLast >= 0 && sinceLast < EXTENSION_LIVENESS_WINDOW_MS);
  return {
    connected,
    pollerWaiting,
    lastSeenMs: sinceLast,
    pendingCommands: queue.length,
    liveness_window_ms: EXTENSION_LIVENESS_WINDOW_MS,
  };
}

/** @internal — test-only: reset the connectivity tracker. */
export function _resetExtensionStatus(): void {
  lastPollAt = 0;
  pollerWaiting = 0;
}

/** @internal — test-only: simulate that the extension just polled. */
export function _markExtensionSeen(at: number = Date.now()): void {
  lastPollAt = at;
}

function findUnpicked(): PendingEntry | null {
  for (const e of queue) if (!e.picked) return e;
  return null;
}

function dispatchToNextWaiter(): void {
  if (pollWaiters.length === 0) return;
  const e = findUnpicked();
  if (!e) return;
  e.picked = true;
  e.pickedAt = Date.now();
  try { markBrowserCommandRunning(e.command.cmd_id); } catch { /* best-effort */ }
  const waiter = pollWaiters.shift()!;
  waiter(e.command);
}

function timeoutMessage(entry: PendingEntry, requested: number): string {
  if (!entry.picked) {
    return (
      `command timed out after ${requested}ms before the browser extension picked it up. ` +
      `Open Chrome, click the Jarela toolbar icon to wake the extension, then retry.`
    );
  }
  const pickedAgo = entry.pickedAt ? Date.now() - entry.pickedAt : requested;
  const log = getBrowserCommandLog(entry.command.cmd_id);
  const phase = log?.last_phase ? ` Last known phase: ${log.last_phase}.` : "";
  return (
    `command timed out after ${requested}ms; the browser extension picked it up ${Math.round(pickedAgo / 1000)}s ago but did not return a result. ` +
    `Check the target tab for a Jarela approval prompt, a stuck page load, or a blocked browser action, then retry.` +
    phase
  );
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
  // Fast-fail when the extension is offline so the agent gets a clear
  // error in <1s instead of waiting the full per-command timeout. A
  // healthy extension long-polls every ~25s; if we haven't seen it in
  // the liveness window AND no poller is parked right now, treat it as
  // disconnected.
  const status = getExtensionStatus();
  if (!status.connected) {
    const cmd_id = randomUUID();
    const seenHint =
      status.lastSeenMs < 0
        ? "no poll has ever arrived on this server"
        : `last poll was ${Math.round(status.lastSeenMs / 1000)}s ago`;
    return {
      cmd_id,
      promise: Promise.resolve({
        cmd_id,
        ok: false,
        error:
          `Jarela browser extension is not connected (${seenHint}). ` +
          `Open Chrome, click the Jarela toolbar icon to wake the extension, ` +
          `then retry the command.`,
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
  try { createBrowserCommandLog(cmd_id, payload); } catch (err) { console.warn("[jarela/browser] failed to log command enqueue:", err); }
  let resolveOuter!: (r: BrowserResult) => void;
  const promise = new Promise<BrowserResult>((res) => { resolveOuter = res; });
  const expiry = setTimeout(() => {
    if (byId.has(cmd_id)) {
      const entry = byId.get(cmd_id)!;
      const error = timeoutMessage(entry, requested);
      removeEntry(cmd_id);
      try { completeBrowserCommandLog(cmd_id, { ok: false, error }); } catch { /* best-effort */ }
      resolveOuter({
        cmd_id,
        ok: false,
        error,
      });
    }
  }, requested);
  const entry: PendingEntry = { command, resolve: resolveOuter, expiry, picked: false, pickedAt: null };
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
    e.pickedAt = Date.now();
    try { markBrowserCommandRunning(e.command.cmd_id); } catch { /* best-effort */ }
    return Promise.resolve(e.command);
  }
  return new Promise((resolve) => {
    let settled = false;
    pollerWaiting += 1;
    const settle = (v: BrowserCommand | null) => {
      if (settled) return;
      settled = true;
      pollerWaiting = Math.max(0, pollerWaiting - 1);
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
  try { completeBrowserCommandLog(result.cmd_id, result); } catch { /* best-effort */ }
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function awaitBrowserCommand(
  payload: BrowserCommandPayload,
  timeout_ms: number | undefined,
): Promise<Response> {
  const { promise } = enqueueCommand(payload, { timeout_ms });
  const result = await promise;
  if (!result.ok) return jsonResponse({ error: result.error }, 503);
  return jsonResponse(result.data ?? null);
}

export async function handleBrowserPoll(req: Request): Promise<Response> {
  if (!isLoopbackRequest(req)) return loopbackForbidden();
  // Mark the extension as seen on every poll, regardless of whether a
  // command is delivered or the wait times out — both prove the SW is
  // alive right now.
  lastPollAt = Date.now();
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

export async function handleBrowserProgress(req: Request): Promise<Response> {
  if (!isLoopbackRequest(req)) return loopbackForbidden();
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  const parsed = BrowserProgressBodyShape.safeParse(raw);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "invalid progress body");
  markBrowserCommandProgress(parsed.data.cmd_id, parsed.data.phase);
  return jsonResponse({ ok: true });
}

export async function handleBrowserStatus(req: Request): Promise<Response> {
  if (!isLoopbackRequest(req)) return loopbackForbidden();
  return new Response(JSON.stringify(getExtensionStatus()), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Ambient surroundings ingest (ADR-0082). The extension pushes the page the
 * user is looking at while its side panel is open; DELETE retracts it when
 * the panel closes. Metadata only — page content stays behind the explicit
 * browser_snapshot / browser_extract tools.
 */
export async function handleBrowserForeground(req: Request): Promise<Response> {
  if (!isLoopbackRequest(req)) return loopbackForbidden();
  if (req.method === "DELETE") {
    clearForegroundTabPresence();
    return jsonResponse({ ok: true, cleared: true });
  }
  if (!isAmbientContextEnabled()) {
    // Retract anything already held so turning the setting off takes effect
    // immediately rather than at the next TTL expiry.
    clearForegroundTabPresence();
    return jsonResponse({ ok: true, accepted: false, reason: "ambient context disabled" });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  const parsed = BrowserForegroundBodyShape.safeParse(raw);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "invalid foreground body");
  const { url, title, host, tab_id, recorded_at } = parsed.data;
  let derivedHost = host ?? "";
  if (!derivedHost) {
    try { derivedHost = new URL(url).hostname; } catch { derivedHost = ""; }
  }
  setForegroundTabPresence({
    url,
    title: title ?? "",
    host: derivedHost,
    tab_id: tab_id ?? null,
    recorded_at: recorded_at ?? Date.now(),
  });
  return jsonResponse({ ok: true, accepted: true });
}

export async function handleBrowserTabs(req: Request): Promise<Response> {
  if (!isLoopbackRequest(req)) return loopbackForbidden();
  const url = new URL(req.url);
  const parsed = BrowserTabsQueryShape.safeParse({
    include_unusable: url.searchParams.get("include_unusable") ?? undefined,
    timeout_ms: url.searchParams.get("timeout_ms") ?? undefined,
  });
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "invalid tabs query");
  const includeUnusable = parsed.data.include_unusable ?? true;
  return awaitBrowserCommand(
    { type: "tabs", include_unusable: includeUnusable },
    parsed.data.timeout_ms ?? 10_000,
  );
}

export async function handleBrowserActivate(req: Request): Promise<Response> {
  if (!isLoopbackRequest(req)) return loopbackForbidden();
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  const parsed = BrowserActivateBodyShape.safeParse(raw);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "invalid activate body");
  return awaitBrowserCommand(
    { type: "activate_tab", tab_id: parsed.data.tab_id },
    parsed.data.timeout_ms ?? 10_000,
  );
}

export async function handleBrowserHistory(req: Request): Promise<Response> {
  if (!isLoopbackRequest(req)) return loopbackForbidden();
  const url = new URL(req.url);
  const parsed = BrowserHistoryQueryShape.safeParse({ limit: url.searchParams.get("limit") ?? undefined });
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "invalid history query");
  return jsonResponse({ commands: listBrowserCommandLogs(parsed.data.limit ?? 50) });
}

export async function handleBrowserRetry(req: Request): Promise<Response> {
  if (!isLoopbackRequest(req)) return loopbackForbidden();
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  const parsed = BrowserRetryBodyShape.safeParse(raw);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "invalid retry body");
  const entry = getBrowserCommandLog(parsed.data.cmd_id);
  if (!entry) return jsonResponse({ error: "unknown browser command" }, 404);
  if (!entry.retryable || !entry.retry_payload) return jsonResponse({ error: "browser command is not retryable" }, 409);
  return awaitBrowserCommand(entry.retry_payload, parsed.data.timeout_ms ?? 30_000);
}

/** @internal — exported for the agent-side tool layer; do not import elsewhere. */
export { CommandShape as _CommandShape };
