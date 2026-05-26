// Plain-text flatteners for remote document RAG (ADR-0026).
//
// Jira issue bodies and comments arrive as Atlassian Document Format
// (ADF) — a JSON tree of typed nodes. Confluence page bodies arrive as
// HTML (the `storage` representation). Both have to be flattened to plain
// text before being chunked by `lib/documents/chunker.ts`, which assumes
// paragraph-delimited text.
//
// These flatteners are intentionally lossy: they keep textual content
// and paragraph structure, drop markup, links, attachments, embeds.
// "Good enough for retrieval" is the bar — not "round-trips to source".

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
}

/** Flatten an ADF JSON tree into paragraph-separated plain text. */
export function adfToText(adf: unknown): string {
  if (!adf || typeof adf !== "object") return "";
  const parts: string[] = [];
  function walk(node: AdfNode, depth = 0): void {
    if (!node) return;
    if (typeof node.text === "string") {
      parts.push(node.text);
      return;
    }
    const block = node.type && /paragraph|heading|listItem|codeBlock|blockquote|panel/.test(node.type);
    if (Array.isArray(node.content)) {
      for (const c of node.content) walk(c, depth + 1);
    }
    if (block) parts.push("\n\n");
  }
  walk(adf as AdfNode);
  // Collapse runs of >2 newlines and trim.
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

/** Strip Confluence storage-format HTML to plain text. */
export function htmlToText(html: string): string {
  if (!html) return "";
  let s = html;
  // Drop script / style blocks entirely.
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Confluence macros sometimes embed CDATA — keep the inner text.
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Block-level closes → newline.
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|br|hr|blockquote|pre)\s*>/gi, "\n");
  // Self-closing <br>.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Drop all remaining tags.
  s = s.replace(/<[^>]+>/g, "");
  // Decode the handful of entities Atlassian actually emits.
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  // Collapse runs of >2 newlines and trim trailing space per line.
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
