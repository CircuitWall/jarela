// Cap a string at `maxBytes` UTF-8 bytes. Returns the original (and
// truncated:false) when already under the cap. Counting bytes — not chars —
// matters for emoji / CJK / accented characters where char-count would let
// the payload double the byte budget.
export function truncateBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return { text: s, truncated: false };

  let start = 0;
  let end = s.length;
  while (start < end) {
    const middle = start + Math.ceil((end - start) / 2);
    if (Buffer.byteLength(s.slice(0, middle), "utf8") > maxBytes) {
      end = middle - 1;
    } else {
      start = middle;
    }
  }
  end = safeUtf16Boundary(s, start);
  return { text: s.slice(0, end), truncated: true };
}

function safeUtf16Boundary(s: string, end: number): number {
  const previous = s.charCodeAt(end - 1);
  const next = s.charCodeAt(end);
  return end > 0
    && end < s.length
    && previous >= 0xD800
    && previous <= 0xDBFF
    && next >= 0xDC00
    && next <= 0xDFFF
    ? end - 1
    : end;
}

export function truncateText(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  if (maxChars <= 0) return "";

  const end = safeUtf16Boundary(s, maxChars - 1);
  return `${s.slice(0, end)}…`;
}

function isUtf8ContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

// Byte window for paged reads: moves `[start, start + limit)` inside `buf` onto
// UTF-8 character boundaries so a page never splits a multi-byte character.
// The start backs up to its lead byte, and the end backs up so it does not cut
// a character — unless that character alone exceeds `limit`, in which case the
// whole character is included so paging always makes progress.
export function utf8ByteWindow(buf: Buffer, start: number, limit: number): { start: number; end: number } {
  const span = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : buf.length;
  let s = Number.isFinite(start) ? Math.max(0, Math.min(Math.floor(start), buf.length)) : 0;
  while (s > 0 && isUtf8ContinuationByte(buf[s])) s--;
  let e = Math.min(buf.length, s + span);
  if (e < buf.length && isUtf8ContinuationByte(buf[e])) {
    let lead = e;
    while (lead > s && isUtf8ContinuationByte(buf[lead])) lead--;
    if (lead > s) e = lead;
    else while (e < buf.length && isUtf8ContinuationByte(buf[e])) e++;
  }
  return { start: s, end: e };
}
