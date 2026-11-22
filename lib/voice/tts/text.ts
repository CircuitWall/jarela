// Text projection for speech synthesis.
//
// Two consumers: the whole-reply reader (a finished message) and the live
// splitter (text that is still streaming in). Both must never read markdown
// noise, code, table markup, or file URLs aloud.

/** Best-effort plain-text projection of a finished message body. */
export function plainTextForTts(content: unknown): string {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && "type" in part) {
        const p = part as { type: string; text?: string };
        if (p.type === "text" && typeof p.text === "string") text += `${p.text}\n`;
      }
    }
  }
  text = text
    .replace(/<refs>[\s\S]*?<\/refs>/gi, " ")
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    // A voice clip is the answer, not prose to read back. Drop local audio
    // links entirely so the generic reader cannot say "Voice clip".
    .replace(/\[[^\]]*\]\(\s*\/api\/v1\/files\/[^)]*\.(?:wav|mp3|ogg|webm|m4a)[^)]*\)/gi, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 5000 ? text.slice(0, 5000) : text;
}

/**
 * Clean one already-complete slice of streaming markdown. Unlike
 * `plainTextForTts` this never touches fences (the splitter removes them) and
 * keeps nothing that has no words, so a chunk of pure punctuation is dropped
 * instead of being sent to a voice.
 */
export function cleanSpeechChunk(raw: string): string {
  const text = raw
    .replace(/<refs>[\s\S]*?<\/refs>/gi, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]\(\s*\/api\/v1\/files\/[^)]*\.(?:wav|mp3|ogg|webm|m4a)[^)]*\)/gi, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Table rows ("| a | b |") are markup, not prose.
    .replace(/^[ \t]*\|.*$/gm, " ")
    .replace(/[#>*_~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /[a-z0-9]/i.test(text) ? text : "";
}
