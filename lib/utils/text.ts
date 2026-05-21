// Cap a string at `maxBytes` UTF-8 bytes. Returns the original (and
// truncated:false) when already under the cap. Counting bytes — not chars —
// matters for emoji / CJK / accented characters where char-count would let
// the payload double the byte budget.
export function truncateBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return { text: s, truncated: false };

  // Slice by char until under the byte cap. Linear scan is fine for the
  // ~30KB caps we use; if a caller ever needs MB-scale truncation, swap for
  // a binary search.
  let end = s.length;
  while (end > 0 && Buffer.byteLength(s.slice(0, end), "utf8") > maxBytes) {
    end--;
  }
  return { text: s.slice(0, end), truncated: true };
}
