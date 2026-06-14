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
  type BrowserCommandPayload,
  type BrowserResult,
} from "@/lib/api/browser-control";
import { writeBinaryFile } from "@/lib/files";
import { registerLangChainPackage } from "./langchain-package";

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

function stringifyResult(action: string, result: BrowserResult): string {
  if (!result.ok) {
    return JSON.stringify({ action, ok: false, error: result.error });
  }
  return JSON.stringify({ action, ok: true, data: result.data });
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
  [k: string]: unknown;
}

interface CachedSnapshot {
  at: number;
  tab_id?: number;
  url?: string;
  items: SnapshotInteractive[];
}

const SNAPSHOT_TTL_MS = 5 * 60_000;
let lastSnapshot: CachedSnapshot | null = null;

function asSnapshot(raw: unknown): CachedSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as SnapshotData;
  if (!Array.isArray(d.interactive)) return null;
  const items: SnapshotInteractive[] = [];
  for (const item of d.interactive) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    if (
      typeof it.idx !== "number" ||
      typeof it.role !== "string" ||
      typeof it.name !== "string" ||
      typeof it.selector !== "string"
    ) {
      continue;
    }
    items.push(it as unknown as SnapshotInteractive);
  }
  return {
    at: Date.now(),
    tab_id: typeof d.tab_id === "number" ? d.tab_id : undefined,
    url: typeof d.url === "string" ? d.url : undefined,
    items,
  };
}

function getSnapshot(): CachedSnapshot | null {
  if (!lastSnapshot) return null;
  if (Date.now() - lastSnapshot.at > SNAPSHOT_TTL_MS) {
    lastSnapshot = null;
    return null;
  }
  return lastSnapshot;
}

/** @internal — test-only: clear the snapshot cache. */
export function _resetSnapshotCache(): void {
  lastSnapshot = null;
}

type LocatorInput = {
  selector?: string;
  handle?: number;
  role?: string;
  name?: string;
};

type Locator = { ok: true; selector: string } | { ok: false; error: string };

export function resolveLocator(input: LocatorInput): Locator {
  if (input.selector) return { ok: true, selector: input.selector };
  if (typeof input.handle === "number") {
    const snap = getSnapshot();
    if (!snap) {
      return {
        ok: false,
        error: `no recent snapshot to resolve handle ${input.handle}. Call browser_snapshot first (or pass an explicit selector).`,
      };
    }
    const item = snap.items.find((i) => i.idx === input.handle);
    if (!item) {
      return {
        ok: false,
        error: `handle ${input.handle} is not in the last snapshot (${snap.items.length} items). Re-run browser_snapshot to refresh handles.`,
      };
    }
    return { ok: true, selector: item.selector };
  }
  if (input.role || input.name) {
    if (!input.role || !input.name) {
      return {
        ok: false,
        error: "`role` and `name` must be provided together to look up an element by accessible name.",
      };
    }
    const snap = getSnapshot();
    if (!snap) {
      return {
        ok: false,
        error: `no recent snapshot to resolve role="${input.role}" name="${input.name}". Call browser_snapshot first.`,
      };
    }
    const wantName = input.name.toLowerCase();
    let candidates = snap.items.filter(
      (i) => i.role === input.role && i.name.toLowerCase() === wantName,
    );
    if (candidates.length === 0) {
      candidates = snap.items.filter(
        (i) => i.role === input.role && i.name.toLowerCase().includes(wantName),
      );
    }
    if (candidates.length === 0) {
      return {
        ok: false,
        error: `no ${input.role} with accessible name "${input.name}" in the last snapshot.`,
      };
    }
    if (candidates.length > 1) {
      const hits = candidates
        .slice(0, 5)
        .map((i) => `handle ${i.idx} (${i.name})`)
        .join(", ");
      return {
        ok: false,
        error: `${candidates.length} ${input.role}s match name "${input.name}" — disambiguate with a numeric handle: ${hits}.`,
      };
    }
    return { ok: true, selector: candidates[0].selector };
  }
  return { ok: false, error: "provide one of `selector`, `handle`, or `role` + `name`." };
}

export interface SnapshotDiff {
  url?: string;
  baseline: "first" | "diff";
  total: number;
  unchanged: number;
  added: SnapshotInteractive[];
  removed: SnapshotInteractive[];
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
      added: next.items.slice(0, 40),
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
    added: added.slice(0, 25),
    removed: removed.slice(0, 15),
  };
}

function formatActionResult(action: string, result: BrowserResult): string {
  if (!result.ok) {
    return JSON.stringify({ action, ok: false, error: result.error });
  }
  const data = (result.data ?? {}) as Record<string, unknown>;
  const snap = asSnapshot(data.snapshot);
  if (!snap) {
    return JSON.stringify({ action, ok: true, data });
  }
  const prev = lastSnapshot;
  lastSnapshot = snap;
  const diff = diffInteractive(prev, snap);
  // Strip the bulky snapshot blob from `data`; the diff already carries
  // every interactive element the agent needs and the `page` summary
  // gives URL/title context. Total payload is ~20% of the full snapshot
  // on the common "a couple of new controls appeared" case.
  const { snapshot: _drop, ...rest } = data;
  void _drop;
  const page: Record<string, unknown> = {
    url: snap.url,
    total_interactive: snap.items.length,
  };
  const rawSnap = data.snapshot as Record<string, unknown> | undefined;
  if (rawSnap && typeof rawSnap.title === "string") page.title = rawSnap.title;
  return JSON.stringify({
    action,
    ok: true,
    data: rest,
    page,
    diff,
    hint:
      "`diff.added` / `diff.removed` list the elements that changed after this action. Refer to them via `handle: <idx>` or `role`+`name` on the next browser_click / browser_fill — no need to call browser_snapshot first.",
  });
}

// --------------------------------------------------------------------- //
// navigate                                                              //
// --------------------------------------------------------------------- //

export const browserNavigateTool = tool(
  async ({ url, wait_for_selector, timeout_ms }) => {
    const result = await run(
      { type: "navigate", url, wait_for_selector, auto_snapshot: true },
      timeout_ms,
    );
    return formatActionResult("browser_navigate", result);
  },
  {
    name: "browser_navigate",
    description:
      "Drive the user's browser: navigate the active tab to `url`. The Jarela browser extension must be installed and connected. " +
      "Returns once the page reports loaded (or `wait_for_selector` resolves). The response includes a `diff` of the interactive controls on the new page — use the numeric `handle` from those entries (or `role`+`name`) on the next `browser_click`/`browser_fill` instead of calling `browser_snapshot` first. Fall back to `browser_screenshot` only when the visual layout itself matters. " +
      "Use this only when the user has explicitly asked you to drive their browser — opening arbitrary URLs surprises users.",
    schema: z.object({
      url: z.string().url().describe("Absolute http(s) URL to navigate the active tab to."),
      wait_for_selector: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe("CSS selector to wait for before returning. Useful when the target page is JS-rendered."),
      timeout_ms: TimeoutMs,
    }),
  },
);

// --------------------------------------------------------------------- //
// click                                                                 //
// --------------------------------------------------------------------- //

export const browserClickTool = tool(
  async ({ selector, handle, role, name, timeout_ms }) => {
    const loc = resolveLocator({ selector, handle, role, name });
    if (!loc.ok) {
      return JSON.stringify({ action: "browser_click", ok: false, error: loc.error });
    }
    const result = await run(
      { type: "click", selector: loc.selector, auto_snapshot: true },
      timeout_ms,
    );
    return formatActionResult("browser_click", result);
  },
  {
    name: "browser_click",
    description:
      "Click an element in the active tab. Identify the target with EXACTLY ONE of: `selector` (CSS), `handle` (numeric `idx` from the most recent `browser_snapshot` or auto-snapshot diff), or `role` + `name` (accessible-name lookup against the last snapshot). The response includes a fresh diff so you can chain the next action without a separate snapshot call.",
    schema: z.object({
      selector: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe("CSS selector for the element to click. Use this when you have an exact selector in hand."),
      handle: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Numeric `idx` from the most recent snapshot/diff. Invalidated when the page re-snapshots."),
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
      timeout_ms: TimeoutMs,
    }),
  },
);

// --------------------------------------------------------------------- //
// fill                                                                  //
// --------------------------------------------------------------------- //

export const browserFillTool = tool(
  async ({ selector, handle, role, name, value, submit, timeout_ms }) => {
    const loc = resolveLocator({ selector, handle, role, name });
    if (!loc.ok) {
      return JSON.stringify({ action: "browser_fill", ok: false, error: loc.error });
    }
    const result = await run(
      { type: "fill", selector: loc.selector, value, submit, auto_snapshot: true },
      timeout_ms,
    );
    return formatActionResult("browser_fill", result);
  },
  {
    name: "browser_fill",
    description:
      "Type `value` into the input/textarea/contenteditable in the active tab. Identify the target with EXACTLY ONE of: `selector` (CSS), `handle` (numeric `idx` from the most recent snapshot/diff), or `role` + `name`. " +
      "When `submit` is true the form is submitted after typing (or Enter is dispatched on a bare input). The response includes a fresh diff so you can chain the next action without a separate snapshot call.",
    schema: z.object({
      selector: z.string().min(1).max(2000).optional().describe("CSS selector for the field to fill."),
      handle: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Numeric `idx` from the most recent snapshot/diff."),
      role: z
        .string()
        .min(1)
        .max(60)
        .optional()
        .describe("ARIA-like role (`textbox`, `combobox`, ...). Pair with `name`."),
      name: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Accessible name of the field. Pair with `role`."),
      value: z.string().max(50_000).describe("Text to type into the field. Replaces the existing value."),
      submit: z.boolean().optional().describe("Submit the enclosing form (or press Enter) after typing."),
      timeout_ms: TimeoutMs,
    }),
  },
);

// --------------------------------------------------------------------- //
// scroll                                                                //
// --------------------------------------------------------------------- //

export const browserScrollTool = tool(
  async ({ selector, to, timeout_ms }) => {
    const result = await run({ type: "scroll", selector, to }, timeout_ms);
    return stringifyResult("browser_scroll", result);
  },
  {
    name: "browser_scroll",
    description:
      "Scroll the active tab. `to: top|bottom` scrolls the viewport. With `selector` and `to: into-view` scrolls the matching element into view.",
    schema: z.object({
      selector: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe("CSS selector. Required when `to` is `into-view`; ignored otherwise."),
      to: z.enum(["top", "bottom", "into-view"]).describe("Scroll target."),
      timeout_ms: TimeoutMs,
    }),
  },
);

// --------------------------------------------------------------------- //
// screenshot                                                            //
// --------------------------------------------------------------------- //

interface ScreenshotData {
  base64?: string;
  media_type?: string;
}

export const browserScreenshotTool = tool(
  async ({ selector, format, full_page, timeout_ms }) => {
    const result = await run(
      { type: "screenshot", selector, format: format ?? "png", full_page },
      timeout_ms,
    );
    if (!result.ok) return stringifyResult("browser_screenshot", result);
    const sd = (result.data ?? {}) as ScreenshotData;
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
      },
      hint: "Embed the screenshot in your reply by writing the `markdown` field verbatim.",
    });
  },
  {
    name: "browser_screenshot",
    description:
      "Take a screenshot of the active tab and store it as a local file. Returns a `/api/v1/files/<name>` URL and a ready-to-use `markdown` snippet. " +
      "Without `selector` the visible viewport is captured; with `selector` only that element is cropped. `full_page: true` captures the entire scrollable page when supported.",
    schema: z.object({
      selector: z.string().min(1).max(2000).optional().describe("CSS selector to crop to."),
      format: z.enum(["png", "jpeg"]).optional().describe("Image format. Defaults to png."),
      full_page: z.boolean().optional().describe("Capture the whole scrollable page rather than just the viewport."),
      timeout_ms: TimeoutMs,
    }),
  },
);

// --------------------------------------------------------------------- //
// extract                                                               //
// --------------------------------------------------------------------- //

export const browserExtractTool = tool(
  async ({ selector, format, max_chars, timeout_ms }) => {
    const result = await run(
      { type: "extract", selector, format: format ?? "text", max_chars },
      timeout_ms,
    );
    return stringifyResult("browser_extract", result);
  },
  {
    name: "browser_extract",
    description:
      "Read text or HTML from the active tab. Without `selector` returns the whole body; with one returns the matching element. " +
      "`format: text` strips markup (default), `html` returns innerHTML, `outerHTML` includes the element tag itself.",
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
      timeout_ms: TimeoutMs,
    }),
  },
);

// --------------------------------------------------------------------- //
// snapshot                                                              //
// --------------------------------------------------------------------- //

export const browserSnapshotTool = tool(
  async ({ max_items, include_hidden, timeout_ms }) => {
    const result = await run(
      { type: "snapshot", max_items, include_hidden },
      timeout_ms,
    );
    if (result.ok) {
      const snap = asSnapshot(result.data);
      if (snap) lastSnapshot = snap;
    }
    return stringifyResult("browser_snapshot", result);
  },
  {
    name: "browser_snapshot",
    description:
      "Return a compact, structured map of the active tab — URL, title, headings, landmarks, and a numbered list of every interactive control (links, buttons, inputs, selects, etc.) with `role`, accessible `name`, and a CSS `selector`. The numeric `idx` on each entry is a short-lived `handle` you can pass to `browser_click` / `browser_fill` instead of repeating the selector. " +
      "You usually do NOT need to call this explicitly: `browser_navigate` / `browser_click` / `browser_fill` already return a fresh diff. Call this when you want the full inventory of the page (e.g. to plan a multi-step flow) or when the cached snapshot is stale (>5 minutes old).",
    schema: z.object({
      max_items: z
        .number()
        .int()
        .positive()
        .max(300)
        .optional()
        .describe("Cap the number of interactive elements returned. Defaults to 80."),
      include_hidden: z
        .boolean()
        .optional()
        .describe("Include elements hidden by CSS / aria-hidden. Defaults to false."),
      timeout_ms: TimeoutMs,
    }),
  },
);

registerLangChainPackage({
  category: "Web",
  tools: {
    read: [browserScreenshotTool, browserExtractTool, browserSnapshotTool],
    write: [browserNavigateTool, browserClickTool, browserFillTool, browserScrollTool],
  },
});