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
// navigate                                                              //
// --------------------------------------------------------------------- //

export const browserNavigateTool = tool(
  async ({ url, wait_for_selector, timeout_ms }) => {
    const result = await run({ type: "navigate", url, wait_for_selector }, timeout_ms);
    return stringifyResult("browser_navigate", result);
  },
  {
    name: "browser_navigate",
    description:
      "Drive the user's browser: navigate the active tab to `url`. The Jarela browser extension must be installed and connected. " +
      "Returns once the page reports loaded (or `wait_for_selector` resolves). After navigation, prefer `browser_snapshot` to see the structured page (URL, headings, every clickable/fillable element with a ready-to-use selector) — it's far faster than a screenshot-and-vision round-trip. Reach for `browser_screenshot` only when the visual layout itself matters. " +
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
  async ({ selector, timeout_ms }) => {
    const result = await run({ type: "click", selector }, timeout_ms);
    return stringifyResult("browser_click", result);
  },
  {
    name: "browser_click",
    description:
      "Click an element in the active tab matching the CSS `selector`. Use querySelector-compatible syntax (e.g. `button[data-action=submit]`). Errors if no element matches.",
    schema: z.object({
      selector: z.string().min(1).max(2000).describe("CSS selector for the element to click."),
      timeout_ms: TimeoutMs,
    }),
  },
);

// --------------------------------------------------------------------- //
// fill                                                                  //
// --------------------------------------------------------------------- //

export const browserFillTool = tool(
  async ({ selector, value, submit, timeout_ms }) => {
    const result = await run({ type: "fill", selector, value, submit }, timeout_ms);
    return stringifyResult("browser_fill", result);
  },
  {
    name: "browser_fill",
    description:
      "Type `value` into the input/textarea/contenteditable matched by `selector` in the active tab. " +
      "When `submit` is true the form is submitted after typing (or Enter is dispatched on a bare input).",
    schema: z.object({
      selector: z.string().min(1).max(2000).describe("CSS selector for the field to fill."),
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
    return stringifyResult("browser_snapshot", result);
  },
  {
    name: "browser_snapshot",
    description:
      "Return a compact, structured map of the active tab — URL, title, headings, landmarks, and a numbered list of every interactive control (links, buttons, inputs, selects, etc.) with `role`, accessible `name`, and a CSS `selector` you can pass straight to `browser_click` / `browser_fill`. " +
      "Prefer this over `browser_screenshot` when deciding what to click or fill: it's an order of magnitude faster than a vision round-trip and gives the agent the exact selector to use. Only fall back to `browser_screenshot` when the visual layout itself matters (charts, images, captchas, layout-driven choices).",
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