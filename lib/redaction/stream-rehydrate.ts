// Stream-aware rehydrator. The model's streamed response can split a
// «SECRET:<id> type=<hint>» placeholder across multiple deltas — yielding
// a half-placeholder to the UI is a leak. This buffer holds back any
// suffix that *might* be the start of a placeholder and only emits text
// once we know the held-back portion can't form one.

import type { MaskContext } from "./mask";

const OPEN = "«";
const CLOSE = "»";

export class StreamRehydrator {
  private buffer = "";
  constructor(private ctx: MaskContext) {}

  // Feed one streamed delta. Returns rehydrated text safe to forward to
  // the user; any unfinished placeholder candidate is held internally
  // until enough subsequent deltas arrive to close (or rule out) it.
  push(delta: string): string {
    if (!delta) return "";
    this.buffer += delta;
    return this.drain(/* final */ false);
  }

  // Call once at end-of-stream to flush whatever remains. If a half-open
  // placeholder is still hanging, it is emitted as-is — that means the
  // model produced a malformed token, not that we're leaking secret
  // material.
  flush(): string {
    return this.drain(/* final */ true);
  }

  private drain(final: boolean): string {
    let out = "";
    while (this.buffer.length > 0) {
      const openIdx = this.buffer.indexOf(OPEN);
      if (openIdx === -1) {
        // No active placeholder candidate. Forward everything.
        out += this.ctx.rehydrate(this.buffer);
        this.buffer = "";
        break;
      }
      // Forward everything before the candidate.
      if (openIdx > 0) {
        out += this.ctx.rehydrate(this.buffer.slice(0, openIdx));
        this.buffer = this.buffer.slice(openIdx);
      }
      // Look for the close.
      const closeIdx = this.buffer.indexOf(CLOSE);
      if (closeIdx === -1) {
        // Open with no close yet — hold the whole buffer.
        if (final) {
          out += this.buffer;
          this.buffer = "";
        }
        break;
      }
      // Emit through the close character; rehydrate handles substitution.
      const candidate = this.buffer.slice(0, closeIdx + 1);
      out += this.ctx.rehydrate(candidate);
      this.buffer = this.buffer.slice(closeIdx + 1);
    }
    return out;
  }
}
