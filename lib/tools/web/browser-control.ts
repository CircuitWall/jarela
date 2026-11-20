// Browser-control agent tools. Each tool enqueues a command on the
// shared queue in `lib/api/browser-control.ts`, awaits the extension's
// outcome, and returns a stringified result the LLM can read. The
// user's installed Jarela browser extension is the executor — these
// tools are NO-OP without it (they will time out with a clear message).
//
// Why this lives in `lib/tools` instead of a `lib/integrations/browser`
// entry: the executor is a runtime peer (the user's already-open
// browser), not a third-party SaaS, so there are no credentials to
// manage and no manifest to register. See ADR-0038 for the capability
// classification — `read` for extract/screenshot, `write` for
// navigate/click/fill/scroll (they mutate page state).

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  enqueueCommand,
  extensionMismatchHint,
  type BrowserCommandPayload,
  type BrowserResult,
} from "@/lib/api/browser-control";
import { writeBinaryFile, writeTextFile } from "@/lib/files";
import { isAppOrigin } from "@/lib/api/app-origin";
import { registerLangChainPackage } from "../packages/langchain-package";
import { withStreamDefault } from "../support/tool-metadata";

const TimeoutMs = z
  .number()
  .int()
  .positive()
  .max(MAX_COMMAND_TIMEOUT_MS)
  .optional()
  .describe(
    `Per-command timeout in milliseconds. Defaults to ${DEFAULT_COMMAND_TIMEOUT_MS}; capped at ${MAX_COMMAND_TIMEOUT_MS}.`,
  );

async function run(
  payload: BrowserCommandPayload,
  timeout_ms: number | undefined,
): Promise<BrowserResult> {
  const { promise } = enqueueCommand(payload, { timeout_ms });
  return promise;
}

// A stale service worker and a broken command produce the same sentence
// from the extension. When the extension reports an older wire contract,
// say so — that is the difference between "reload it" and "debug it".
function withMismatchHint(error: string): string {
  const hint = extensionMismatchHint();
  return hint ? `${error} (${hint})` : error;
}

// Chrome refuses to script a page whose origin the extension has no host
// permission for ("Cannot access contents of the url ... Extension manifest
// must request permission ..."), and `chrome.permissions.request` needs a user
// gesture, so the agent can never fix this itself. Left as a bare error the
// model retried the same call and eventually gave up without ever asking;
// classifying it gives the tool-usage SOP something to branch on.
const PERMISSION_DENIED_PATTERNS = [
  /cannot access contents of/i,
  /extension manifest must request permission/i,
  /must request permission to access/i,
  /missing host permission/i,
  /no host permissions? for/i,
];

export function hostPermissionRequired(error: string | undefined): { hostname?: string } | null {
  if (!error) return null;
  if (!PERMISSION_DENIED_PATTERNS.some((re) => re.test(error))) return null;
  // Chrome usually names the origin; take the first host it mentions.
  const match = error.match(/https?:\/\/([^\s/'"`]+)/i);
  return match ? { hostname: match[1].toLowerCase() } : {};
}

// The extension accepted a command and never answered. The common reason is
// that it is holding the command behind its own approval prompt, on a tab the
// user is not looking at — nobody answers, the command times out, and the
// retryable wording sends the agent straight back into the same wall.
const AWAITING_APPROVAL_PATTERN = /picked it up .*did not return a result/i;
const EXTENSION_ASLEEP_PATTERN = /before the browser extension picked it up|browser extension is not connected/i;

function withAskInstruction(error: string): Record<string, unknown> {
  if (/the Jarela app itself/i.test(error)) {
    return {
      error_code: "app_self_target",
      error: withMismatchHint(error),
      ask_user: true,
      retryable: false,
      next_step:
        "This tab is the app the user is talking to you in. Target another tab, or pass allow_app_tab only when the " +
        "user explicitly asked you to drive the Jarela app itself. Do not retry the same call unchanged.",
    };
  }
  if (AWAITING_APPROVAL_PATTERN.test(error)) {
    return {
      error_code: "extension_approval_pending",
      error: withMismatchHint(error),
      ask_user: true,
      retryable: false,
      next_step:
        "Stop and tell the user: a Jarela approval prompt is waiting on the target tab (it appears in the page overlay, " +
        "with Always allow persisting the choice). Do not retry until the user answers; if no prompt is visible, ask them " +
        "to bring that tab to the foreground and retry once.",
    };
  }
  if (EXTENSION_ASLEEP_PATTERN.test(error)) {
    return {
      error_code: "extension_not_responding",
      error: withMismatchHint(error),
      ask_user: true,
      retryable: false,
      next_step:
        "Stop and tell the user the Jarela browser extension is not answering. Ask them to open the browser, click the " +
        "Jarela toolbar icon to wake it, and confirm it is connected; then retry once.",
    };
  }
  const denied = hostPermissionRequired(error);
  if (!denied) return { error: withMismatchHint(error) };
  const host = denied.hostname;
  return {
    error_code: "host_permission_required",
    error: withMismatchHint(error),
    ...(host ? { hostname: host } : {}),
    ask_user: true,
    retryable: false,
    next_step:
      "Stop retrying this call. Ask the user once with " +
      `propose_config_change({ kind: "allow_site", payload: { hostname: "${host ?? "<hostname>"}" }, reason: "..." }) ` +
      "and state that approval lets the agent drive a tab on this host and share its cookies with web_fetch. " +
      "The answer is saved in Settings → Allowed sites (revocable there). Only after the user answers, retry.",
  };
}

function stringifyResult(action: string, result: BrowserResult): string {
  if (!result.ok) {
    return JSON.stringify({ action, ok: false, ...withAskInstruction(result.error) });
  }
  return JSON.stringify({ action, ok: true, data: result.data });
}

const EXTRACT_INLINE_CHAR_LIMIT = 12_000;
const EXTRACT_PREVIEW_CHAR_LIMIT = 2_000;
const DEFAULT_NAVIGATE_TIMEOUT_MS = 90_000;
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const DEFAULT_BATCH_BASE_MS = 20_000;
const DEFAULT_BATCH_STEP_MS = 8_000;

type ExtractOutputMode = "auto" | "inline" | "file";

interface BrowserExtractData {
  matched?: boolean;
  format?: string;
  content?: string;
  truncated?: boolean;
  original_length?: number;
  offset?: number;
  next_offset?: number | null;
  [k: string]: unknown;
}

function extensionForExtractFormat(format: string | undefined): "txt" | "html" {
  return format === "html" || format === "outerHTML" ? "html" : "txt";
}

function maybeReduceExtractResult(result: BrowserResult, output: ExtractOutputMode): string {
  if (!result.ok) return stringifyResult("browser_extract", result);
  const data = (result.data ?? {}) as BrowserExtractData;
  const content = typeof data.content === "string" ? data.content : "";
  const shouldWrite = output === "file" || (output === "auto" && (content.length > EXTRACT_INLINE_CHAR_LIMIT || data.truncated === true));
  if (!shouldWrite) return stringifyResult("browser_extract", result);

  const ext = extensionForExtractFormat(data.format);
  const name = `browser-extract-${randomUUID()}.${ext}`;
  writeTextFile(name, content);
  const { content: _content, ...rest } = data;
  void _content;
  const preview = content.slice(0, EXTRACT_PREVIEW_CHAR_LIMIT);
  const ref = {
    name,
    uri: `/api/v1/files/${name}`,
    mimeType: ext === "html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
    size: Buffer.byteLength(content, "utf8"),
    chars: content.length,
  };
  return JSON.stringify({
    action: "browser_extract",
    ok: true,
    data: {
      ...rest,
      result_ref: ref,
      content_ref: ref,
      preview,
      preview_chars: preview.length,
    },
    hint:
      data.truncated === true
        ? "The extract was reduced into a local file. Call tool_result_get with result_ref.name to read it, then call browser_extract again with offset=next_offset to continue the page."
        : "The extract was reduced into a local file. Call tool_result_get with result_ref.name to read the full content.",
  });
}

// --------------------------------------------------------------------- //
// Snapshot cache + locator resolution.                                  //
// --------------------------------------------------------------------- //
// The extension can return a fresh page snapshot piggybacked on a
// click/fill/navigate result (`auto_snapshot: true`). We cache it
// here so the next agent call can refer to elements by numeric
// `handle` or by `role` + accessible `name` without first invoking
// `browser_snapshot` again. A 5-minute TTL means a stale agent that
// wakes up much later still gets a clear "no recent snapshot" error
// rather than dispatching against a vanished DOM.

export interface SnapshotInteractive {
  idx: number;
  ref: number;
  role: string;
  name: string;
  selector: string;
  [k: string]: unknown;
}

interface SnapshotData {
  url?: unknown;
  title?: unknown;
  tab_id?: unknown;
  interactive?: unknown;
  tree?: unknown;
  [k: string]: unknown;
}

interface CachedSnapshot {
  at: number;
  tab_id?: number;
  url?: string;
  fingerprint?: string;
  raw?: Record<string, unknown>;
  items: SnapshotInteractive[];
}

// Snapshots are cached per tab. The old single module-level slot meant a
// workflow that touched two tabs constantly invalidated its own handles —
// and handles are now durable refs, so the cache is only used to answer
// `browser_snapshot` cheaply and to diff what an action changed.
const SNAPSHOT_TTL_MS = 5 * 60_000;
const snapshotsByTab = new Map<number, CachedSnapshot>();
// Only used to answer a cheap `browser_snapshot` from cache; the cache
// itself is still keyed per tab so two-tab workflows cannot collide.
let lastSnapshotTabId: number | null = null;
// `browser_tabs` hands out small symbolic handles because a raw Chrome tab
// id is a large number that the redaction layer masks in tool output.
const TAB_INVENTORY_TTL_MS = 5 * 60_000;
let lastTabInventory: { at: number; byRef: Map<number, number> } | null = null;

function asSnapshot(raw: unknown): CachedSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as SnapshotData;
  if (!Array.isArray(d.interactive)) return null;
  const items: SnapshotInteractive[] = [];
  for (const item of d.interactive) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    if (
      typeof it.role !== "string" ||
      typeof it.name !== "string" ||
      typeof it.selector !== "string"
    ) {
      continue;
    }
    if (typeof it.idx !== "number") continue;
    items.push({
      ...(it as unknown as SnapshotInteractive),
      ref: typeof it.ref === "number" ? it.ref : it.idx,
    });
  }
  return {
    at: Date.now(),
    tab_id: typeof d.tab_id === "number" ? d.tab_id : undefined,
    url: typeof d.url === "string" ? d.url : undefined,
    fingerprint: typeof d.fingerprint === "string" ? d.fingerprint : undefined,
    raw: d as Record<string, unknown>,
    items,
  };
}

function rememberSnapshot(snap: CachedSnapshot): void {
  const tabId = snap.tab_id;
  if (typeof tabId !== "number") return;
  snapshotsByTab.set(tabId, snap);
  lastSnapshotTabId = tabId;
}

function getSnapshot(tabId: number | undefined, maxAgeMs = SNAPSHOT_TTL_MS): CachedSnapshot | null {
  if (typeof tabId !== "number") return null;
  const snap = snapshotsByTab.get(tabId);
  if (!snap) return null;
  if (Date.now() - snap.at > maxAgeMs) {
    snapshotsByTab.delete(tabId);
    return null;
  }
  return snap;
}

function cachedSnapshotResult(tabId: number | undefined, maxAgeMs: number | undefined): string | null {
  const snap = getSnapshot(tabId, maxAgeMs ?? SNAPSHOT_TTL_MS);
  if (!snap) return null;
  const raw = snap.raw ?? { url: snap.url, tab_id: snap.tab_id, interactive: snap.items };
  const { interactive: _drop, ...rest } = raw as Record<string, unknown>;
  void _drop;
  return JSON.stringify({
    action: "browser_snapshot",
    ok: true,
    data: {
      ...rest,
      ...(Array.isArray(raw.interactive) ? { interactive: snap.items } : {}),
      cache: {
        hit: true,
        age_ms: Date.now() - snap.at,
        max_age_ms: maxAgeMs ?? SNAPSHOT_TTL_MS,
        fingerprint: snap.fingerprint ?? null,
      },
    },
    hint: "Reused the recent page map. Pass force_refresh=true if the page changed or the cached controls look stale.",
  });
}

/** @internal — test-only: clear the snapshot cache. */
export function _resetSnapshotCache(): void {
  snapshotsByTab.clear();
}

export interface LocatorInput {
  selector?: string;
  ref?: number;
  /** @deprecated alias for `ref`, kept so older prompts keep working. */
  handle?: number;
  role?: string;
  name?: string;
}

export interface TargetLocator {
  selector?: string;
  ref?: number;
  role?: string;
  name?: string;
}

export type LocatorResolution =
  | { ok: true; locator: TargetLocator }
  | { ok: false; error: string };

/**
 * Turn the tool's locator fields into the locator the extension will resolve
 * against the live DOM. There is deliberately no server-side lookup: a
 * handle is now the durable `ref` the extension handed out, and a
 * role + name pair is resolved in the page at execution time. That removes
 * the "no recent snapshot" failure mode entirely and, more importantly,
 * removes the stale CSS string that caused most click/fill misses.
 */
export function resolveLocator(input: LocatorInput): LocatorResolution {
  const ref = typeof input.ref === "number" ? input.ref : input.handle;
  if (input.selector && (typeof ref === "number" || input.role || input.name)) {
    return { ok: false, error: "provide exactly one of `selector`, `ref`, or `role` + `name`." };
  }
  if (input.selector) return { ok: true, locator: { selector: input.selector } };
  if (typeof ref === "number") return { ok: true, locator: { ref } };
  if (input.role && input.name) return { ok: true, locator: { role: input.role, name: input.name } };
  if (input.role || input.name) {
    return { ok: false, error: "`role` and `name` must be provided together to look up an element by accessible name." };
  }
  return { ok: false, error: "provide one of `selector`, `ref`, or `role` + `name`." };
}

function describeLocator(locator: TargetLocator): string {
  if (locator.selector) return `selector \`${locator.selector}\``;
  if (locator.role && locator.name) return `${locator.role} "${locator.name}"`;
  if (typeof locator.ref === "number") return `ref ${locator.ref}`;
  return "target";
}

export interface SnapshotItemRef {
  ref: number;
  role: string;
  name: string;
  disabled?: boolean;
}

export interface SnapshotDiff {
  url?: string;
  baseline: "first" | "diff";
  total: number;
  unchanged: number;
  added: SnapshotItemRef[];
  removed: SnapshotItemRef[];
}

function toItemRef(item: SnapshotInteractive): SnapshotItemRef {
  return {
    ref: item.ref,
    role: item.role,
    name: item.name,
    ...(item.disabled === true ? { disabled: true } : {}),
  };
}

export function diffInteractive(
  prev: CachedSnapshot | null,
  next: CachedSnapshot,
): SnapshotDiff {
  if (!prev || prev.url !== next.url) {
    return {
      url: next.url,
      baseline: "first",
      total: next.items.length,
      unchanged: 0,
      added: next.items.slice(0, 40).map(toItemRef),
      removed: [],
    };
  }
  const key = (i: SnapshotInteractive) => `${i.role}|${i.name}|${i.selector}`;
  const prevKeys = new Set(prev.items.map(key));
  const nextKeys = new Set(next.items.map(key));
  const added = next.items.filter((i) => !prevKeys.has(key(i)));
  const removed = prev.items.filter((i) => !nextKeys.has(key(i)));
  return {
    url: next.url,
    baseline: "diff",
    total: next.items.length,
    unchanged: next.items.length - added.length,
    added: added.slice(0, 25).map(toItemRef),
    removed: removed.slice(0, 15).map(toItemRef),
  };
}

function formatActionResult(action: string, result: BrowserResult): string {
  if (!result.ok) {
    return JSON.stringify({
      action,
      ok: false,
      ...withAskInstruction(result.error),
      ...(result.data !== undefined ? { data: result.data } : {}),
    });
  }
  const data = (result.data ?? {}) as Record<string, unknown>;
  const snap = asSnapshot(data.snapshot);
  if (!snap) {
    return JSON.stringify({ action, ok: true, data });
  }
  const prev = getSnapshot(snap.tab_id);
  rememberSnapshot(snap);
  const diff = diffInteractive(prev, snap);
  // Strip the bulky snapshot blob from `data`; the diff already carries
  // every control the agent needs to chain the next step, and the `page`
  // summary gives URL/title context.
  const { snapshot: _drop, ...rest } = data;
  void _drop;
  const rawSnap = data.snapshot as Record<string, unknown> | undefined;
  const page: Record<string, unknown> = {
    url: snap.url,
    total_interactive: snap.items.length,
  };
  if (rawSnap && typeof rawSnap.title === "string") page.title = rawSnap.title;
  if (rawSnap && typeof rawSnap.text === "string") page.text = clipText(rawSnap.text, 1_500);
  return JSON.stringify({
    action,
    ok: true,
    data: rest,
    page,
    diff,
    hint:
      "`diff.added` / `diff.removed` list the elements that changed after this action. Refer to them by `ref` on the next browser_click / browser_fill — no need to call browser_snapshot first.",
  });
}

function clipText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Render the extension's structured tree as indented text. The tree is the
 * model's reading surface: it carries structure, labels, and the refs needed
 * to act, which is what removes the snapshot → extract second call.
 */
export function formatTree(tree: unknown, limit = 200): string | null {
  if (!Array.isArray(tree) || tree.length === 0) return null;
  const lines: string[] = [];
  for (const node of tree.slice(0, limit)) {
    if (!node || typeof node !== "object") continue;
    const n = node as Record<string, unknown>;
    if (typeof n.role !== "string") continue;
    const depth = typeof n.depth === "number" ? Math.max(0, Math.min(n.depth, 20)) : 0;
    const label = typeof n.name === "string" ? n.name : "";
    const ref = typeof n.ref === "number" ? ` [ref ${n.ref}]` : "";
    lines.push(`${"  ".repeat(depth)}${n.role}${label ? ` "${label}"` : ""}${ref}`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

// --------------------------------------------------------------------- //
// navigate                                                              //
// --------------------------------------------------------------------- //

export const browserNavigateTool = withStreamDefault(tool(
  async ({ url, to, wait_for_selector, allow_app_tab, timeout_ms }) => {
    if (!url && !to) {
      return JSON.stringify({ action: "browser_navigate", ok: false, error: "provide either `url` or `to` (back/forward/reload)." });
    }
    if (url && to) {
      return JSON.stringify({ action: "browser_navigate", ok: false, error: "provide either `url` or `to`, not both." });
    }
    // Refuse before dispatching when the target is the app itself: the trip
    // through the extension only discovers this on the current tab, and an
    // agent that navigates the conversation tab closes the chat it is in.
    if (url && !allow_app_tab && isAppOrigin(url)) {
      return JSON.stringify({
        action: "browser_navigate",
        ok: false,
        ...withAskInstruction("this url is the Jarela app itself"),
      });
    }
    const result = await run(
      { type: "navigate", ...(url ? { url } : {}), ...(to ? { to } : {}), wait_for_selector, allow_app_tab, auto_snapshot: true },
      timeout_ms ?? DEFAULT_NAVIGATE_TIMEOUT_MS,
    );
    return formatActionResult("browser_navigate", result);
  },
  {
    name: "browser_navigate",
    description:
      "Drive the user's browser: open `url`, or move through history with `to: \"back\" | \"forward\" | \"reload\"`. The Jarela browser extension must be installed and connected. " +
      "Returns once the page reports loaded (or `wait_for_selector` resolves) and reports a tab crash or discard instead of timing out. The response includes a `diff` of the interactive controls on the new page — use the numeric `ref` from those entries on the next `browser_click`/`browser_fill` instead of calling `browser_snapshot` first. " +
      "Only http and https URLs are accepted. " +
      "Uses a 90s default timeout so approval prompts and slow navigations have enough room; pass `timeout_ms` only when you intentionally want a different budget. " +
      "Use this only when the user has explicitly asked you to drive their browser — opening arbitrary URLs surprises users.",
    schema: z.object({
      url: z.string().url().optional().describe("Absolute http(s) URL to navigate the active tab to."),
      to: z
        .enum(["back", "forward", "reload"])
        .optional()
        .describe("History move instead of a URL. Use `reload` after the page changed server-side."),
      wait_for_selector: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe("CSS selector to wait for before returning. Useful when the target page is JS-rendered."),
      allow_app_tab: z
        .boolean()
        .optional()
        .describe(
          "Set only when the user explicitly asked you to navigate the Jarela app tab. Without it, navigating the tab that is running the conversation is refused, because it would close the chat the user is watching.",
        ),
      timeout_ms: TimeoutMs,
    }),
  },
), true);

// --------------------------------------------------------------------- //
// click                                                                 //
// --------------------------------------------------------------------- //

const LocatorFields = {
  selector: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe("CSS selector. Use this only when you already hold an exact selector; prefer `ref`."),
  ref: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Durable handle from browser_snapshot or a previous action `diff`. Resolved in the page, so it survives re-renders."),
  role: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe("ARIA-like role (`button`, `link`, `textbox`, ...). Pair with `name`."),
  name: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Accessible name (case-insensitive; exact match preferred, otherwise substring). Pair with `role`."),
};

export const browserClickTool = withStreamDefault(tool(
  async ({ selector, ref, role, name, timeout_ms }) => {
    const loc = resolveLocator({ selector, ref, role, name });
    if (!loc.ok) {
      return JSON.stringify({ action: "browser_click", ok: false, error: loc.error });
    }
    const result = await run(
      { type: "click", ...loc.locator, auto_snapshot: true },
      timeout_ms,
    );
    return formatActionResult("browser_click", result);
  },
  {
    name: "browser_click",
    description:
      "Click an element in the active tab. Identify the target with EXACTLY ONE of: `ref` (from the most recent snapshot or action diff), `role` + `name` (accessible-name lookup), or `selector` (CSS, last resort). " +
      "Resolution happens against the live DOM and a stale or ambiguous target is retried once after refreshing the page map, so you do not need a `browser_snapshot` call between steps. " +
      "The response includes a fresh diff so you can chain the next action directly.",
    schema: z.object({ ...LocatorFields, timeout_ms: TimeoutMs }),
  },
), true);

export const browserPressTool = withStreamDefault(tool(
  async ({ selector, ref, role, name, key, timeout_ms }) => {
    const hasLocator = Boolean(selector) || typeof ref === "number" || Boolean(role) || Boolean(name);
    const loc = hasLocator
      ? resolveLocator({ selector, ref, role, name })
      : { ok: true as const, locator: {} };
    if (!loc.ok) {
      return JSON.stringify({ action: "browser_press", ok: false, error: loc.error });
    }
    const result = await run(
      { type: "press", ...loc.locator, key, auto_snapshot: true },
      timeout_ms,
    );
    return formatActionResult("browser_press", result);
  },
  {
    name: "browser_press",
    description:
      "Press a key or chord in the active tab: `key: \"Escape\"`, `\"Enter\"`, `\"Tab\"`, `\"ArrowDown\"`, or a chord such as `\"Control+a\"`. " +
      "Without a locator the key goes to the focused element, which is how you dismiss a modal or a menu. With a locator the element is focused first. " +
      "Use this instead of clicking when a control only reacts to the keyboard.",
    schema: z.object({
      ...LocatorFields,
      key: z.string().min(1).max(80).describe("Key, chord (`Control+a`), or named key such as `Enter` / `Escape` / `Tab`."),
      timeout_ms: TimeoutMs,
    }),
  },
), true);

// --------------------------------------------------------------------- //
// fill                                                                  //
// --------------------------------------------------------------------- //

export const browserFillTool = withStreamDefault(tool(
  async ({ selector, ref, role, name, value, submit, timeout_ms }) => {
    const loc = resolveLocator({ selector, ref, role, name });
    if (!loc.ok) {
      return JSON.stringify({ action: "browser_fill", ok: false, error: loc.error });
    }
    const result = await run(
      { type: "fill", ...loc.locator, value, submit, auto_snapshot: true },
      timeout_ms,
    );
    return formatActionResult("browser_fill", result);
  },
  {
    name: "browser_fill",
    description:
      "Type `value` into the input/textarea/contenteditable (or choose an option in a `<select>`) in the active tab. Identify the target with EXACTLY ONE of: `ref`, `role` + `name`, or `selector`. " +
      "For a select, pass the option's value or its visible text. " +
      "When `submit` is true the enclosing form is submitted after typing. The response includes a fresh diff so you can chain the next action without a separate snapshot call.",
    schema: z.object({
      ...LocatorFields,
      value: z.string().max(50_000).describe("Text to type into the field. Replaces the existing value."),
      submit: z.boolean().optional().describe("Submit the enclosing form (or press Enter) after typing."),
      timeout_ms: TimeoutMs,
    }),
  },
), true);

// --------------------------------------------------------------------- //
// fill_many                                                             //
// --------------------------------------------------------------------- //

const LocatorField = z.object({
  ...LocatorFields,
  value: z.string().max(50_000).describe("Text to type into the field. Replaces the existing value."),
});

export const browserFillManyTool = withStreamDefault(tool(
  async ({ fields, submit_selector, submit_ref, timeout_ms }) => {
    const resolved = [];
    for (const [idx, field] of fields.entries()) {
      const loc = resolveLocator(field);
      if (!loc.ok) {
        return JSON.stringify({
          action: "browser_fill_many",
          ok: false,
          error: `field ${idx}: ${loc.error}`,
        });
      }
      resolved.push({ ...loc.locator, value: field.value });
    }
    const result = await run(
      { type: "fill_many", fields: resolved, submit_selector, submit_ref, auto_snapshot: true },
      timeout_ms,
    );
    return formatActionResult("browser_fill_many", result);
  },
  {
    name: "browser_fill_many",
    description:
      "Fill multiple fields in the active tab in one browser round-trip. Prefer this over repeated `browser_fill` calls for forms. " +
      "Each field uses EXACTLY ONE locator: `ref`, `role` + `name`, or `selector`. " +
      "Raw values are sent only to the local browser extension and are not included in command history. Use `submit_ref` (preferred) or `submit_selector` to submit after all fields are filled.",
    schema: z.object({
      fields: z.array(LocatorField).min(1).max(25).describe("Fields to fill, in page order."),
      submit_ref: z.number().int().min(0).optional().describe("Ref of the submit control to click after filling."),
      submit_selector: z.string().min(1).max(2000).optional().describe("CSS selector for the submit button to click after all fields are filled."),
      timeout_ms: TimeoutMs,
    }),
  },
), true);

// --------------------------------------------------------------------- //
// scroll                                                                //
// --------------------------------------------------------------------- //

export const browserScrollTool = withStreamDefault(tool(
  async ({ selector, ref, role, name, to, timeout_ms }) => {
    if (to !== "into-view") {
      const result = await run({ type: "scroll", to }, timeout_ms);
      return stringifyResult("browser_scroll", result);
    }
    const loc = resolveLocator({ selector, ref, role, name });
    if (!loc.ok) {
      return JSON.stringify({ action: "browser_scroll", ok: false, error: loc.error });
    }
    const result = await run({ type: "scroll", ...loc.locator, to }, timeout_ms);
    return stringifyResult("browser_scroll", result);
  },
  {
    name: "browser_scroll",
    description:
      "Scroll the active tab. `to: top|bottom` scrolls the viewport. With `to: into-view` plus a locator (`ref`, `role` + `name`, or `selector`) scrolls that element into view.",
    schema: z.object({
      ...LocatorFields,
      to: z.enum(["top", "bottom", "into-view"]).describe("Scroll target."),
      timeout_ms: TimeoutMs,
    }),
  },
), true);

// --------------------------------------------------------------------- //
// wait                                                                  //
// --------------------------------------------------------------------- //

export const browserWaitTool = withStreamDefault(tool(
  async ({ for: waitFor, selector, text, url, quiet_ms, timeout_ms }) => {
    const result = await run(
      { type: "wait", for: waitFor, selector, text, url, quiet_ms, timeout_ms },
      timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS + 5_000,
    );
    return stringifyResult("browser_wait", result);
  },
  {
    name: "browser_wait",
    description:
      "Wait for a page condition before the next step: `for: \"selector\"` (element appears), `\"text\"` (visible text appears), `\"url\"` (location matches), `\"idle\"` (DOM quiet and document complete), `\"time\"` (fixed pause). " +
      "Use this instead of re-snapshotting in a loop when an action starts a request or a render. `idle` is a DOM-quiet check, not a network-inspector claim.",
    schema: z.object({
      for: z.enum(["selector", "text", "url", "idle", "time"]).describe("Condition to wait for."),
      selector: z.string().min(1).max(2000).optional().describe("Required when `for` is `selector`."),
      text: z.string().min(1).max(2000).optional().describe("Required when `for` is `text`. Case-insensitive substring."),
      url: z.string().min(1).max(2000).optional().describe("Required when `for` is `url`. Case-insensitive substring of location.href."),
      quiet_ms: z.number().int().positive().max(10_000).optional().describe("Quiet window for `for: idle`. Defaults to 500ms."),
      timeout_ms: TimeoutMs,
    }),
  },
), true);

// --------------------------------------------------------------------- //
// batch                                                                 //
// --------------------------------------------------------------------- //

const BatchExpectField = z.object({
  selector: z.string().min(1).max(2000).optional(),
  text: z.string().min(1).max(2000).optional(),
  url: z.string().min(1).max(2000).optional(),
  idle: z.boolean().optional(),
  timeout_ms: z.number().int().positive().max(MAX_COMMAND_TIMEOUT_MS).optional(),
});

const BatchStepField = z.object({
  action: z.enum(["navigate", "click", "fill", "fill_many", "scroll", "press", "wait"]),
  ...LocatorFields,
  url: z.string().url().optional(),
  to: z.enum(["back", "forward", "reload", "top", "bottom", "into-view"]).optional(),
  value: z.string().max(50_000).optional(),
  submit: z.boolean().optional(),
  fields: z.array(LocatorField).min(1).max(25).optional(),
  submit_selector: z.string().min(1).max(2000).optional(),
  key: z.string().min(1).max(80).optional(),
  for: z.enum(["selector", "text", "url", "idle", "time"]).optional(),
  text: z.string().min(1).max(2000).optional(),
  timeout_ms: z.number().int().positive().max(MAX_COMMAND_TIMEOUT_MS).optional(),
  expect: BatchExpectField.optional(),
});

export const browserBatchTool = withStreamDefault(tool(
  async ({ steps, timeout_ms }) => {
    const budget = timeout_ms ?? Math.min(MAX_COMMAND_TIMEOUT_MS, DEFAULT_BATCH_BASE_MS + steps.length * DEFAULT_BATCH_STEP_MS);
    const result = await run({ type: "batch", steps, auto_snapshot: true }, budget);
    return formatActionResult("browser_batch", result);
  },
  {
    name: "browser_batch",
    description:
      "Run an ordered list of browser steps in ONE extension round trip. This is the default for any multi-step flow: click → type → press Enter → expect results, or fill several fields and submit. " +
      "Each step is `{ action, ...step fields, expect? }`. Steps run in order and stop at the first failure or unmet expectation; later steps are reported as not executed, so nothing runs against a page that has already diverged. " +
      "Put an `expect` on the step whose effect you care about (`selector`, `text`, `url`, or `idle`) instead of adding a `wait` step. " +
      "The response lists per-step status plus one diff of the page afterwards. Do not wrap a single action in a batch; call that tool directly. " +
      "A step that needs the user's approval stops the batch and surfaces the prompt.",
    schema: z.object({
      steps: z.array(BatchStepField).min(1).max(20).describe("Ordered steps. Each is one action, optionally followed by its expectation."),
      timeout_ms: TimeoutMs,
    }),
  },
), true);

// --------------------------------------------------------------------- //
// screenshot                                                            //
// --------------------------------------------------------------------- //

interface ScreenshotData {
  base64?: string;
  media_type?: string;
}

export const browserScreenshotTool = withStreamDefault(tool(
  async ({ selector, ref, format, full_page, timeout_ms }) => {
    const hasLocator = Boolean(selector) || typeof ref === "number";
    const loc = hasLocator ? resolveLocator({ selector, ref }) : { ok: true as const, locator: {} };
    if (!loc.ok) {
      return JSON.stringify({ action: "browser_screenshot", ok: false, error: loc.error });
    }
    const result = await run(
      { type: "screenshot", ...loc.locator, format: format ?? "png", full_page },
      timeout_ms,
    );
    if (!result.ok) return stringifyResult("browser_screenshot", result);
    const sd = (result.data ?? {}) as ScreenshotData & { activated_for_capture?: boolean };
    if (!sd.base64) {
      return JSON.stringify({
        action: "browser_screenshot",
        ok: false,
        error: "extension returned no image data",
      });
    }
    // Persist the PNG/JPEG to ~/.jarela/files so the chat UI can render
    // it inline via the markdown URL and the file outlives the SSE turn.
    // Same storage shape `generate_image` already uses.
    const mime = sd.media_type ?? (format === "jpeg" ? "image/jpeg" : "image/png");
    const ext = mime === "image/jpeg" ? "jpg" : "png";
    const name = `browser-${randomUUID()}.${ext}`;
    const data = Buffer.from(sd.base64, "base64");
    writeBinaryFile(name, data);
    const url = `/api/v1/files/${name}`;
    return JSON.stringify({
      action: "browser_screenshot",
      ok: true,
      data: {
        url,
        markdown: `![browser screenshot](${url})`,
        media_type: mime,
        bytes: data.length,
        ...(sd.activated_for_capture ? { activated_for_capture: true } : {}),
      },
      hint: "Embed the screenshot in your reply by writing the `markdown` field verbatim.",
    });
  },
  {
    name: "browser_screenshot",
    description:
      "Take a screenshot of the active tab and store it as a local file. Returns a `/api/v1/files/<name>` URL and a ready-to-use `markdown` snippet. " +
      "Without a locator the visible viewport is captured; with `ref` or `selector` only that element is cropped. A pinned or background target is briefly activated for the capture and the user's tab is restored afterwards. " +
      "Screenshots are a visual fallback — use `browser_snapshot` for reading structure and text. `full_page` cannot be honoured from a viewport capture and says so.",
    schema: z.object({
      ...LocatorFields,
      format: z.enum(["png", "jpeg"]).optional().describe("Image format. Defaults to png."),
      full_page: z.boolean().optional().describe("Request the whole scrollable page. Reported back as unavailable when it cannot be honoured."),
      timeout_ms: TimeoutMs,
    }),
  },
), true);

// --------------------------------------------------------------------- //
// extract                                                               //
// --------------------------------------------------------------------- //

export const browserExtractTool = withStreamDefault(tool(
  async ({ selector, format, max_chars, offset, output, timeout_ms }) => {
    const result = await run(
      { type: "extract", selector, format: format ?? "text", max_chars, offset },
      timeout_ms,
    );
    return maybeReduceExtractResult(result, output ?? "auto");
  },
  {
    name: "browser_extract",
    description:
      "Read text or HTML from the active tab. Without `selector` returns the whole body; with one returns the matching element. " +
      "`format: text` strips markup (default), `html` returns innerHTML, `outerHTML` includes the element tag itself. " +
      "For large pages, read in chunks: if `truncated` is true, call again with `offset` set to `next_offset` until it returns null.",
    schema: z.object({
      selector: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe("CSS selector to scope the extraction to. Omit to extract the whole page body."),
      format: z.enum(["text", "html", "outerHTML"]).optional().describe("Output format. Defaults to `text`."),
      max_chars: z
        .number()
        .int()
        .positive()
        .max(200_000)
        .optional()
        .describe("Cap the returned content at this many characters. Default is unbounded up to the extension's own page-size limit."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Start reading at this character offset. Use `next_offset` from a truncated prior result to continue a large page."),
      output: z
        .enum(["auto", "inline", "file"])
        .optional()
        .describe("How to return extracted content. `auto` writes large/truncated content to a local file with preview metadata; `inline` returns content directly; `file` always writes a local file."),
      timeout_ms: TimeoutMs,
    }),
  },
), true);

// --------------------------------------------------------------------- //
// snapshot                                                              //
// --------------------------------------------------------------------- //

export const browserSnapshotTool = withStreamDefault(tool(
  async ({ filter, depth, ref, max_items, include_inventory, include_hidden, force_refresh, max_age_ms, timeout_ms }) => {
    const effectiveFilter = filter ?? "interactive";
    const cacheable =
      !force_refresh &&
      !include_hidden &&
      !max_items &&
      typeof ref !== "number" &&
      !depth &&
      !include_inventory &&
      effectiveFilter === "interactive";
    if (cacheable) {
      const cached = cachedSnapshotResult(lastSnapshotTabId ?? undefined, max_age_ms);
      if (cached) return cached;
    }
    const result = await run(
      {
        type: "snapshot",
        max_items,
        include_hidden,
        filter: effectiveFilter,
        depth,
        ref,
      },
      timeout_ms,
    );
    if (!result.ok) return stringifyResult("browser_snapshot", result);
    const data = (result.data ?? {}) as Record<string, unknown>;
    const snap = asSnapshot(data);
    if (snap) rememberSnapshot(snap);
    const { interactive: _interactive, tree: rawTree, text, headings, landmarks, ...rest } = data;
    void _interactive;
    void headings;
    void landmarks;
    const tree = formatTree(rawTree);
    const textValue = typeof text === "string" ? clipText(text, 12_000) : null;
    const hasStructure = tree !== null || typeof rest.url === "string";
    if (!hasStructure && !textValue) {
      // A success with no payload is the worst possible answer: the agent
      // cannot tell a broken extension from an empty page, and every
      // ref-based follow-up then fails for the wrong reason.
      return JSON.stringify({
        action: "browser_snapshot",
        ok: false,
        error:
          withMismatchHint(
            "the extension returned no page structure or text for this tab. " +
            "Reload the extension (chrome://extensions → reload) so its service worker runs current code, then retry.",
          ),
        data: rest,
      });
    }
    return JSON.stringify({
      action: "browser_snapshot",
      ok: true,
      data: {
        ...rest,
        tree,
        text: textValue,
        ...(include_inventory && Array.isArray(_interactive) ? { interactive: _interactive } : {}),
        cache: { hit: false, tab_id: snap?.tab_id ?? null },
      },
      hint:
        tree !== null
          ? "`tree` is the page structure; act with `ref` from the bracketed handles. Pass `include_inventory: true` only when you need selectors or link targets."
          : "The page exposed no actionable structure. Try filter: \"text\" to read it, or browser_extract for raw text.",
    });
  },
  {
    name: "browser_snapshot",
    description:
      "Return the page as an indented accessibility tree — role, accessible name, and a durable `ref` for every control — plus a text excerpt. This is the primary read: it is enough to decide the next action in one call. " +
      "`filter: \"interactive\"` (default) lists only controls; `\"text\"` adds text-bearing nodes; `\"all\"` also includes containers. `depth` caps nesting, `ref` scopes the read to one subtree. " +
      "Repeated calls reuse a recent page map per tab; pass `force_refresh: true` after switching tabs, or when the cached tree looks stale. " +
      "You usually do NOT need this after an action: navigate/click/fill already return a diff with refs.",
    schema: z.object({
      filter: z.enum(["interactive", "text", "all"]).optional().describe("What to include. Defaults to interactive."),
      depth: z.number().int().positive().max(40).optional().describe("Maximum nesting depth. Defaults to 15."),
      ref: z.number().int().min(0).optional().describe("Scope the read to this element's subtree."),
      max_items: z
        .number()
        .int()
        .positive()
        .max(300)
        .optional()
        .describe("Cap the number of interactive elements returned. Defaults to 80."),
      include_inventory: z
        .boolean()
        .optional()
        .describe("Also return the flat inventory (selectors, hrefs, select options). Off by default to keep the payload small."),
      include_hidden: z
        .boolean()
        .optional()
        .describe("Include elements hidden by CSS / aria-hidden. Defaults to false."),
      force_refresh: z
        .boolean()
        .optional()
        .describe("Ignore the per-tab snapshot cache and rediscover the page."),
      max_age_ms: z
        .number()
        .int()
        .positive()
        .max(SNAPSHOT_TTL_MS)
        .optional()
        .describe("Maximum age of a reusable cached snapshot. Defaults to 5 minutes."),
      timeout_ms: TimeoutMs,
    }),
  },
), true);

// --------------------------------------------------------------------- //
// tabs                                                                  //
// --------------------------------------------------------------------- //

export const browserTabsTool = withStreamDefault(tool(
  async ({ include_unusable, timeout_ms }) => {
    const result = await run(
      { type: "tabs", include_unusable: include_unusable ?? true },
      timeout_ms,
    );
    if (!result.ok) return stringifyResult("browser_tabs", result);
    const data = (result.data ?? {}) as { tabs?: unknown; [k: string]: unknown };
    const tabs = Array.isArray(data.tabs) ? (data.tabs as Array<Record<string, unknown>>) : [];
    // `tab_id` is a large browser number, and the redaction layer masks
    // numeric runs of eight or more digits in tool output. Give the model a
    // small symbolic handle it can actually repeat back to
    // `browser_activate_tab`, and keep the numeric id for humans and logs.
    const byRef = new Map<number, number>();
    const annotated = tabs.map((tab, index) => {
      const ref = index + 1;
      if (typeof tab.tab_id === "number") byRef.set(ref, tab.tab_id);
      return { tab_ref: ref, ...tab } as Record<string, unknown>;
    });
    lastTabInventory = { at: Date.now(), byRef };
    const unidentified = annotated.filter((tab) => tab.usable === false && !tab.url).length;
    return JSON.stringify({
      action: "browser_tabs",
      ok: true,
      data: {
        ...data,
        tabs: annotated,
        ...(unidentified > 0
          ? {
              metadata_hint:
                `${unidentified} tab(s) could not be identified because Chrome withheld their title and URL. ` +
                "Grant host access for those sites in the Jarela extension options to see and target them.",
            }
          : {}),
      },
      hint: "Address a tab with `tab_ref` (small and stable for this inventory) rather than `tab_id`.",
    });
  },
  {
    name: "browser_tabs",
    description:
      "List browser tabs known to the Jarela extension: a small `tab_ref`, tab id, window id, active/focused/pinned/foreground markers, title, URL/host when permissions allow, and whether the tab can be scripted. " +
      "Use `tab_ref` with `browser_activate_tab`. The inventory is a snapshot in time: re-run this if a target tab was opened or closed since. " +
      "Tabs whose title and URL were withheld need host access granted in the extension options.",
    schema: z.object({
      include_unusable: z.boolean().optional().describe("Include chrome://, extension, blank, or metadata-unavailable tabs. Defaults to true."),
      timeout_ms: TimeoutMs,
    }),
  },
), true);

export const browserActivateTabTool = withStreamDefault(tool(
  async ({ tab_ref, tab_id, timeout_ms }) => {
    let resolved = tab_id;
    if (typeof resolved !== "number") {
      const inventory = lastTabInventory;
      if (!inventory || Date.now() - inventory.at > TAB_INVENTORY_TTL_MS) {
        return JSON.stringify({
          action: "browser_activate_tab",
          ok: false,
          error: "tab_ref needs a recent tab inventory — call browser_tabs first.",
        });
      }
      const mapped = inventory.byRef.get(tab_ref as number);
      if (typeof mapped !== "number") {
        return JSON.stringify({
          action: "browser_activate_tab",
          ok: false,
          error: `tab_ref ${tab_ref} is not in the last tab inventory (${inventory.byRef.size} tabs). Re-run browser_tabs.`,
        });
      }
      resolved = mapped;
    }
    const result = await run({ type: "activate_tab", tab_id: resolved }, timeout_ms);
    return stringifyResult("browser_activate_tab", result);
  },
  {
    name: "browser_activate_tab",
    description:
      "Focus a browser tab. Pass `tab_ref` from the most recent `browser_tabs` (preferred) or a literal `tab_id`. " +
      "This activates the tab and asks Chromium to focus its window. " +
      "Use only when the user asked you to control browser focus or a workflow clearly needs a different open tab. This does not change the pinned target unless the user pins that tab separately.",
    schema: z.object({
      tab_ref: z.number().int().positive().optional().describe("`tab_ref` from the most recent browser_tabs result."),
      tab_id: z.number().int().positive().optional().describe("Literal Chrome tab id, when you already have one."),
      timeout_ms: TimeoutMs,
    }),
  },
), true);

registerLangChainPackage({
  category: "Web",
  tools: {
    read: [browserScreenshotTool, browserExtractTool, browserSnapshotTool, browserWaitTool, browserTabsTool],
    write: [browserNavigateTool, browserClickTool, browserPressTool, browserFillTool, browserFillManyTool, browserScrollTool, browserBatchTool, browserActivateTabTool],
  },
});