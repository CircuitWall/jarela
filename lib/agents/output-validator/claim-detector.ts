import type { Claim } from "./types";

// First-person past-tense or perfect-tense action verbs that imply work was
// performed in the current turn. We don't try to enumerate every English verb;
// the set covers the dominant fabrication shapes in observed transcripts.
const ACTION_VERBS = [
  "patched", "edited", "wrote", "ran", "verified", "created", "deleted",
  "updated", "committed", "saved", "added", "removed", "fixed", "applied",
  "installed", "configured", "renamed", "moved", "copied", "pushed", "merged",
  "checked", "confirmed", "tested",
];

const VERB_GROUP = ACTION_VERBS.join("|");

const PATTERNS: RegExp[] = [
  // "I patched the file" — bare past tense
  new RegExp(`\\bI\\s+(?:just\\s+)?(${VERB_GROUP})\\b`, "gi"),
  // "I've patched", "I have patched"
  new RegExp(`\\bI(?:'ve|\\s+have)\\s+(${VERB_GROUP})\\b`, "gi"),
  // "Verified the bytes" — leading capital, no subject (common in concise replies)
  new RegExp(`(?:^|\\.\\s+|\\n)(${VERB_GROUP})\\b`, "gi"),
];

const FUTURE_PATTERNS: RegExp[] = [
  // "I'll patch", "I will patch", "I would patch", "I could patch"
  /\bI(?:'ll|\s+will|\s+would|\s+could|\s+should|\s+can|\s+might)\s+\w+/i,
];

export function findActionClaims(text: string): Claim[] {
  const out: Claim[] = [];
  const seen = new Set<string>();
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const verb = m[1].toLowerCase();
      // Skip if this match is inside a future-tense clause. Scan a small
      // backward window for "I'll / I will" before the verb.
      const start = Math.max(0, m.index - 24);
      const window = text.slice(start, m.index + m[0].length);
      if (FUTURE_PATTERNS.some((f) => f.test(window))) continue;
      const key = `${verb}@${m.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ verb, raw: m[0].trim() });
    }
  }
  return out;
}
