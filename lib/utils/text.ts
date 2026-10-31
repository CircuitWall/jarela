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
