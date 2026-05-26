// Plain-text chunker for document RAG (ADR-0024).
//
// Strategy:
// 1. Split on blank-line paragraph boundaries.
// 2. Greedily pack paragraphs into chunks up to ~MAX_CHARS.
// 3. Overlap: prepend the trailing portion of the previous chunk to each
//    new chunk so cross-chunk context survives splits (helps recall when
//    a question spans a paragraph boundary).
//
// Char count is used as a token proxy — 1 token ≈ 4 chars for English.
// MAX_CHARS = 3200 ≈ 800 tokens, well under any embedding-model limit.

const MAX_CHARS = 3200;
const OVERLAP_CHARS = 400;

export interface Chunk {
  text: string;
  start_offset: number; // byte offset (utf-8) into original text
  end_offset: number;
}

export function chunkText(text: string): Chunk[] {
  if (!text || text.length === 0) return [];

  // Split on one-or-more blank lines. Keep paragraphs with their separator
  // so offsets stay accurate.
  const paragraphs: { text: string; start: number; end: number }[] = [];
  let cursor = 0;
  const re = /\n\s*\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = cursor;
    const end = m.index;
    paragraphs.push({ text: text.slice(start, end), start, end });
    cursor = re.lastIndex;
  }
  if (cursor < text.length) {
    paragraphs.push({ text: text.slice(cursor), start: cursor, end: text.length });
  }

  const chunks: Chunk[] = [];
  let buf: { text: string; start: number; end: number } | null = null;

  for (const p of paragraphs) {
    if (!buf) {
      buf = { text: p.text, start: p.start, end: p.end };
      continue;
    }
    if (buf.text.length + 2 + p.text.length <= MAX_CHARS) {
      buf.text = `${buf.text}\n\n${p.text}`;
      buf.end = p.end;
    } else {
      chunks.push({ text: buf.text, start_offset: buf.start, end_offset: buf.end });
      // Overlap: take the tail of the previous chunk.
      const tail = buf.text.slice(Math.max(0, buf.text.length - OVERLAP_CHARS));
      buf = {
        text: `${tail}\n\n${p.text}`,
        // Anchor the new chunk's start_offset at the paragraph that's
        // logically new — the overlap tail is prepended for context only.
        start: p.start,
        end: p.end,
      };
    }
  }
  if (buf) {
    chunks.push({ text: buf.text, start_offset: buf.start, end_offset: buf.end });
  }

  // If a single paragraph is bigger than MAX_CHARS, the above will emit it
  // as one over-sized chunk. Split it on character boundaries as a last
  // resort so we don't exceed the embedding model's input limit.
  const out: Chunk[] = [];
  for (const c of chunks) {
    if (c.text.length <= MAX_CHARS) {
      out.push(c);
      continue;
    }
    let pos = 0;
    while (pos < c.text.length) {
      const end = Math.min(pos + MAX_CHARS, c.text.length);
      out.push({
        text: c.text.slice(pos, end),
        start_offset: c.start_offset + pos,
        end_offset: c.start_offset + end,
      });
      pos = end - OVERLAP_CHARS;
      if (pos < 0) pos = 0;
      if (end === c.text.length) break;
    }
  }
  return out;
}
