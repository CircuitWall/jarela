// Delivery directives that steer speech without appearing in the message.
//
// The agent may start a reply with `[[tone: warm and reassuring]]`. That
// directive never reaches the chat bubble, the transcript that is read back,
// or another channel — it is extracted here and handed to TTS as its `style`.
// Momentary vocal tags (`<sigh>`, `<short pause>`, …) are stripped too: the
// TTS generation this app currently calls treats text as verbatim, so they
// would be read aloud. `keepVocalTags` is the switch for a future
// speech-metadata based provider path.
//
// Stripping is line-wise on purpose: message text can contain fenced code,
// YAML or mermaid where whitespace is significant, so nothing inside a fence
// is touched and only lines that actually contained a directive are tidied.
const TONE_PATTERN = String.raw`\[\[\s*tone\s*:\s*([^\]\n]{1,120}?)\s*\]\]`;
const VOCAL_TAG_PATTERN = String.raw`<\/?\s*(?:short pause|pause|sigh|laugh|gasp|cough|breath|chuckle|groan|sob)\s*\/?>`;
const FENCE = /^\s*(?:```|~~~)/;

export interface VoiceDirectives {
  /** Text with the directives removed — what a human should see/hear. */
  text: string;
  /** Sustained delivery style, or null when the reply has no directive. */
  style: string | null;
}

export interface ParseDirectiveOptions {
  /** Keep `<sigh>`-style tags in `text` (for providers that interpret them). */
  keepVocalTags?: boolean;
}

function cleanStyle(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || null;
}

export function parseVoiceDirectives(raw: string, options: ParseDirectiveOptions = {}): VoiceDirectives {
  let style: string | null = null;
  let inFence = false;
  const lines: string[] = [];

  for (const line of raw.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      lines.push(line);
      continue;
    }
    if (inFence) {
      lines.push(line);
      continue;
    }

    // A directive alone on its line (the documented usage) drops the whole
    // line, so no blank line is left behind.
    const wholeLine = line.match(new RegExp(`^[\\t ]*${TONE_PATTERN}[\\t ]*$`, "i"));
    if (wholeLine) {
      style ??= cleanStyle(wholeLine[1]);
      continue;
    }

    let changed = false;
    let next = line.replace(new RegExp(TONE_PATTERN, "gi"), (_match, value: string) => {
      style ??= cleanStyle(value);
      changed = true;
      return "";
    });
    if (!options.keepVocalTags) {
      next = next.replace(new RegExp(VOCAL_TAG_PATTERN, "gi"), () => {
        changed = true;
        return "";
      });
    }
    if (changed) {
      // Collapse only the gap the removed marker/tag left behind; leading
      // indentation is preserved so this can never break an indented block.
      next = next.replace(/(\S)[ \t]{2,}/g, "$1 ").replace(/[ \t]+$/, "");
      if (!next.trim()) continue;
    }
    lines.push(next);
  }

  return { text: lines.join("\n").replace(/^\n+/, "").trim(), style };
}

/**
 * The exact text to render in the chat bubble / read back as a transcript.
 * Messages without directives are returned unchanged byte-for-byte so code
 * fences and trailing-space line breaks survive.
 */
export function stripVoiceDirectives(raw: string): string {
  return hasVoiceDirectives(raw) ? parseVoiceDirectives(raw).text : raw;
}

export function hasVoiceDirectives(raw: string): boolean {
  return new RegExp(TONE_PATTERN, "i").test(raw) || new RegExp(VOCAL_TAG_PATTERN, "i").test(raw);
}
