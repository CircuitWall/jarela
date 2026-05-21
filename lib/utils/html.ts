// Cheap HTML → plain text. Not a parser — regex-only, deterministic, no deps.
//
// Two modes:
//   - default (preserveParagraphs: false): collapses ALL whitespace to single
//     spaces. Right for web-page summarization where the agent wants prose.
//   - preserveParagraphs: true: keeps newline structure (br → \n, /p → \n\n)
//     and only collapses runs of spaces/tabs. Right for email bodies where the
//     agent benefits from paragraph breaks.
export function stripHtml(html: string, opts?: { preserveParagraphs?: boolean }): string {
  let s = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  if (opts?.preserveParagraphs) {
    s = s
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n");
    // Strip remaining tags with empty (so the br/p newlines we just injected
    // aren't surrounded by stray spaces from the opening tags).
    s = s.replace(/<\/?[^>]+>/g, "");
  } else {
    // Default mode: replace tags with spaces so adjacent words don't merge.
    s = s.replace(/<\/?[^>]+>/g, " ");
  }

  s = decodeHtmlEntities(s);

  s = opts?.preserveParagraphs
    ? s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n")
    : s.replace(/\s+/g, " ");

  return s.trim();
}

export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
