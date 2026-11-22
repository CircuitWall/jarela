// Delivery directives on the browser-voice path.
//
// Gemini TTS accepts a free-form `style` string, but
// `SpeechSynthesisUtterance` has no style input and ignores SSML — the only
// knobs are rate, pitch and volume. A directive is therefore approximated by a
// small keyword table; anything it does not recognise stays neutral rather
// than guessing. This is a hint, not the phrasing control Gemini gives.
export interface SpeechProsody {
  rate: number;
  pitch: number;
  volume: number;
}

export const NEUTRAL_PROSODY: SpeechProsody = { rate: 1, pitch: 1, volume: 1 };

const RULES: ReadonlyArray<{ match: RegExp; prosody: SpeechProsody }> = [
  { match: /\b(whisper\w*|hush\w*|quiet\w*|soft\w*|murmur\w*)\b/i, prosody: { rate: 0.9, pitch: 0.95, volume: 0.45 } },
  { match: /\b(urgent\w*|excited\w*|enthusiast\w*|energetic\w*|cheer\w*|happy|joy\w*)\b/i, prosody: { rate: 1.12, pitch: 1.1, volume: 1 } },
  { match: /\b(slow\w*|careful\w*|measured|patient\w*|deliberate)\b/i, prosody: { rate: 0.85, pitch: 1, volume: 1 } },
  { match: /\b(calm\w*|warm\w*|sooth\w*|gentle|reassur\w*|kind\w*)\b/i, prosody: { rate: 0.92, pitch: 0.96, volume: 1 } },
  { match: /\b(serious\w*|grave|firm\w*|somber|solemn)\b/i, prosody: { rate: 0.95, pitch: 0.9, volume: 1 } },
];

export function browserProsody(style: string | null | undefined): SpeechProsody {
  const value = (style ?? "").trim();
  if (!value) return NEUTRAL_PROSODY;
  for (const rule of RULES) {
    if (rule.match.test(value)) return rule.prosody;
  }
  return NEUTRAL_PROSODY;
}
