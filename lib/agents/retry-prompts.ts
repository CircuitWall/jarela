export interface CitationRepairClaim {
  text: string;
  reason: string;
}

const COMPLETE_ANSWER_REPAIR = "Return a complete corrected answer to the original user request. Preserve all valid explanations, calculations, tables, and conclusions. Correct unsupported action claims: call the missing tool if the user authorized that action, or state honestly that it was not performed. Do not return only a correction or a tool confirmation. Your completed answer will replace the draft; the user must not lose the substantive answer.";

export function buildFabricationNudge(reason: string): string {
  return `\u21bb Auto-retry: output validator flagged your reply${reason ? ` \u2014 ${reason}` : ""}. ${COMPLETE_ANSWER_REPAIR}`;
}

export function buildCitationRetryNudge(claims: readonly CitationRepairClaim[]): string {
  const details = claims.slice(0, 5).map((claim, index) =>
    `  ${index + 1}. ${claim.text}${claim.reason ? ` \u2014 ${claim.reason}` : ""}`,
  ).join("\n");
  return `\u21bb Auto-retry: the citation audit flagged ${claims.length} high-impact claim${claims.length === 1 ? "" : "s"} without a verified source:\n${details}\n\nFix each claim in exactly ONE of these three ways:\n  (a) cite an existing source from the manifest by appending the marker \`[N]\` to the claim,\n  (b) call a tool now (file_read, web_search, fetch_webpage, memory_read) to actually ground the claim before stating it,\n  (c) rephrase plainly: drop the specific number/fact, or say "I don't have a source for this" so the claim is no longer load-bearing.\n\n${COMPLETE_ANSWER_REPAIR} Do NOT invent a marker number that isn't in the manifest.`;
}