// Incremental speech chunking for a reply that is still streaming in.
//
// The reader speaks from the first complete sentence instead of waiting for
// the whole reply: the splitter consumes a growing buffer, hands back every
// slice that is safe to read, and keeps the unfinished tail for next time.
// Code fences and table rows are dropped rather than read aloud, and an
// unclosed fence is buffered until it closes so a half-written block is never
// spoken.
import { cleanSpeechChunk } from "./text";

const FENCE = "```";
const DEFAULT_MAX_CHARS = 180;

// A sentence terminator followed by whitespace, or a blank line between blocks.
const BOUNDARY_RE = /[.!?…](?=["'”’)\]]*\s)|\n\s*\n/g;
const SENTENCE_SPLIT_RE = /(?<=[.!?…])\s+/;

export interface StreamingSpeechSplitter {
  /** Consumes new text and returns the slices that are ready to speak. */
  take(buffer: string, options?: { flush?: boolean }): string[];
  /** Forgets position and buffered text — used when a run restarts. */
  reset(): void;
}

export interface StreamingSpeechConfig {
  /** Longest slice spoken as one clip; longer prose splits at a word gap. */
  maxChars?: number;
}

function lastBoundary(text: string): number {
  BOUNDARY_RE.lastIndex = 0;
  let boundary = 0;
  let match: RegExpExecArray | null;
  while ((match = BOUNDARY_RE.exec(text)) !== null) boundary = match.index + match[0].length;
  return boundary;
}

function speakableSlices(raw: string): string[] {
  const slices: string[] = [];
  for (const piece of raw.split(SENTENCE_SPLIT_RE)) {
    const clean = cleanSpeechChunk(piece);
    if (clean) slices.push(clean);
  }
  return slices;
}

export function createStreamingSpeechSplitter(config: StreamingSpeechConfig = {}): StreamingSpeechSplitter {
  const maxChars = config.maxChars ?? DEFAULT_MAX_CHARS;
  let cursor = 0;
  let inFence = false;
  let pending = "";

  function harvest(force: boolean, out: string[]): void {
    const boundary = lastBoundary(pending);
    if (boundary > 0) {
      out.push(...speakableSlices(pending.slice(0, boundary)));
      pending = pending.slice(boundary);
    }
    // Prose without any terminator still has to be read eventually.
    while (pending.length > maxChars) {
      const space = pending.lastIndexOf(" ", maxChars);
      const cut = space > 0 ? space : maxChars;
      out.push(...speakableSlices(pending.slice(0, cut)));
      pending = pending.slice(cut);
    }
    if (force && pending) {
      out.push(...speakableSlices(pending));
      pending = "";
    }
  }

  return {
    take(buffer, options = {}) {
      const out: string[] = [];
      while (cursor < buffer.length) {
        if (inFence) {
          const close = buffer.indexOf(FENCE, cursor);
          if (close === -1) {
            cursor = buffer.length;
            break;
          }
          inFence = false;
          cursor = close + FENCE.length;
          continue;
        }
        const open = buffer.indexOf(FENCE, cursor);
        const end = open === -1 ? buffer.length : open;
        if (end > cursor) {
          pending += buffer.slice(cursor, end);
          cursor = end;
          harvest(false, out);
          continue;
        }
        // A fence starts here: speak the prose that led into it.
        harvest(true, out);
        inFence = true;
        cursor += FENCE.length;
      }
      if (options.flush) harvest(true, out);
      return out;
    },
    reset() {
      cursor = 0;
      inFence = false;
      pending = "";
    },
  };
}
