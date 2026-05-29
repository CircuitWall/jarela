import { findActionClaims } from "./claim-detector";
import { findCitations } from "./citation-parser";
import type { ValidationResult } from "./types";

const SUMMARY_PATTERNS: RegExp[] = [
  /^#{1,6}\s*Summary(?:\s+of\s+changes)?\b/im,
  /\bI(?:'ve|\s+have)\s+completed\b/i,
  /\bWhat\s+I\s+did\b/i,
];

/**
 * Cross-check the assistant's text output against the tool calls actually
 * issued in this turn. Returns ok=true when nothing fishy is detected,
 * or ok=false with a kind + reason when a fabrication shape is matched.
 *
 * Priority (first match wins): citation_unregistered_tool >
 * citation_uncalled_tool > claim_without_tool > summary_without_action.
 *
 * Lenient principle: when ANY tool was called this turn, action-claim text
 * is allowed (the model legitimately did work, even if its phrasing isn't
 * tagged with `(via ...)`). Citations are checked regardless of tool count.
 */
export function validateAssistantOutput(
  text: string,
  toolCalls: readonly string[],
  allowedTools: readonly string[],
): ValidationResult {
  const calledSet = new Set(toolCalls);
  const allowedSet = new Set(allowedTools);

  // Citation checks run regardless of whether other tools were called —
  // a `(via foo)` tag MUST refer to a registered tool that was actually
  // invoked this turn.
  const citations = findCitations(text);
  for (const c of citations) {
    if (!allowedSet.has(c.tool)) {
      return {
        ok: false,
        kind: "citation_unregistered_tool",
        reason: `You wrote "${c.raw}" but "${c.tool}" is not a registered tool. Either drop the citation or call the correct tool.`,
        evidence: c.raw,
      };
    }
    if (!calledSet.has(c.tool)) {
      return {
        ok: false,
        kind: "citation_uncalled_tool",
        reason: `You wrote "${c.raw}" but did not actually call "${c.tool}" this turn. Call the tool or drop the citation.`,
        evidence: c.raw,
      };
    }
  }

  // Claim and summary checks only fire when zero tools were called. If any
  // tool ran, the text is treated as legitimately describing work done.
  if (toolCalls.length > 0) return { ok: true };

  const claims = findActionClaims(text);
  if (claims.length > 0) {
    const c = claims[0];
    return {
      ok: false,
      kind: "claim_without_tool",
      reason: `You wrote "${c.raw}" but did not call any tool this turn. Either call the tool that performs the action or rephrase as a proposal.`,
      evidence: c.raw,
    };
  }

  for (const re of SUMMARY_PATTERNS) {
    const m = text.match(re);
    if (m) {
      return {
        ok: false,
        kind: "summary_without_action",
        reason: `You wrote a summary section ("${m[0].trim()}") but did not call any tool this turn. Drop the recap or do the work first.`,
        evidence: m[0].trim(),
      };
    }
  }

  return { ok: true };
}
