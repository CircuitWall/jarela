// Browser-extension turn message (refine / fill / rewrite_clipboard).
// `composePrompt` lives next to the server handler so the format is
// authored once. `parseExtensionTurn` reverses it for the chat UI so the
// user bubble can show a tight collapsible card instead of raw text.

import { z } from "zod";

export const ExtensionActionEnum = z.enum(["refine", "fill", "rewrite_clipboard"]);
export type ExtensionAction = z.infer<typeof ExtensionActionEnum>;

export interface ExtensionPromptInput {
  instruction: string;
  text?: string;
  url?: string;
  title?: string;
  selector?: string;
  page_context?: string;
}

export function composePrompt(action: ExtensionAction, input: ExtensionPromptInput): string {
  const header = action === "refine"
    ? "[Extension refine turn] Improve or refine the selected content based on the instruction below."
    : action === "fill"
      ? "[Extension fill turn] Produce text intended to be inserted into the currently focused editable field. Use nearby form context and page context to stay relevant. Return only the final field text."
      : "[Extension rewrite to clipboard turn] Rewrite ONLY the text under 'Selected context:' according to the instruction. Ignore any URL/title/heading hints — they are NOT the rewrite target. Return ONLY the rewritten text, no commentary, no quotes, no labels.";

  const lines = [header, `Instruction: ${input.instruction}`];
  // rewrite_clipboard is intentionally selection-sovereign: the selection IS
  // the input. Page metadata adds noise and the model has been observed
  // echoing the page H1/H2 as the "rewrite" instead of operating on the
  // selection. Strip every page hint for this action.
  if (action !== "rewrite_clipboard") {
    if (input.url) lines.push(`URL: ${input.url}`);
    if (input.title) lines.push(`Title: ${input.title}`);
    if (input.selector) lines.push(`Selector: ${input.selector}`);
    if (input.page_context) lines.push("", "Page/form context:", input.page_context);
  }
  lines.push("", "Selected context:", input.text && input.text.trim().length > 0 ? input.text : "(none provided)");
  return lines.join("\n");
}

export interface ExtensionTurnContext {
  action: ExtensionAction;
  actionLabel: string;
  instruction: string;
  url: string | null;
  title: string | null;
  selector: string | null;
  pageContext: string | null;
  selectedText: string | null;
}

const ACTION_LABEL: Record<ExtensionAction, string> = {
  fill: "Fill focused field",
  refine: "Refine selection",
  rewrite_clipboard: "Rewrite to clipboard",
};

export function parseExtensionTurn(raw: string): ExtensionTurnContext | null {
  const headerRe = /^\[Extension (refine|fill|rewrite to clipboard) turn\][^\n]*\n/;
  const hm = headerRe.exec(raw);
  if (!hm) return null;
  const actionWord = hm[1];
  const action: ExtensionAction =
    actionWord === "fill" ? "fill"
    : actionWord === "refine" ? "refine"
    : "rewrite_clipboard";

  let rest = raw.slice(hm[0].length);
  function takeLine(label: string): string | null {
    const re = new RegExp(`^${label}:\\s*([^\\n]*)\\n?`);
    const m = re.exec(rest);
    if (!m) return null;
    rest = rest.slice(m[0].length);
    return m[1].trim() || null;
  }
  const instruction = takeLine("Instruction") ?? "";
  const url = takeLine("URL");
  const title = takeLine("Title");
  const selector = takeLine("Selector");

  let pageContext: string | null = null;
  const pageHeaderRe = /^\nPage\/form context:\n/;
  if (pageHeaderRe.test(rest)) {
    rest = rest.replace(pageHeaderRe, "");
    const idx = rest.indexOf("\n\nSelected context:");
    if (idx >= 0) {
      pageContext = rest.slice(0, idx).trim() || null;
      rest = rest.slice(idx + 2);
    }
  }

  let selectedText: string | null = null;
  const selHeaderRe = /^\n?Selected context:\n([\s\S]*)$/;
  const sm = selHeaderRe.exec(rest);
  if (sm) {
    const body = sm[1].trim();
    selectedText = body === "(none provided)" ? null : (body || null);
  }

  return {
    action,
    actionLabel: ACTION_LABEL[action],
    instruction,
    url,
    title,
    selector,
    pageContext,
    selectedText,
  };
}
