// Citation checker — second-pass LLM that decides whether the assistant
// turn's factual claims are backed by sources the agent actually visited
// in this thread.
//
// Pipeline:
//   1. extractVisitedSources(threadId)  walks every persisted tool event +
//      the just-produced events to build the {url|path} provenance set.
//   2. extractCitedLinks(assistantText) pulls every markdown link target
//      out of the assistant text (so the checker only spends tokens on
//      messages that actually carry citations — when there are none the
//      verdict is trivially "no claims, no checker call").
//   3. classifyCitations(text, sources, modelConfigName) asks the checker
//      LLM to emit a strict-JSON verdict listing each factual claim, its
//      cited link (if any), and whether that link is in the visited set.
//
// Failure modes (timeout, parse error, missing model config, provider
// throw) all return null. The caller writes metadata only on a non-null
// verdict and the chat UI degrades to "no badge" when metadata is absent.
//
// Design choices:
//   - Provenance scope is the whole thread, not a rolling window. Matches
//     how focused chat threads work in practice and avoids false flags
//     when the agent legitimately re-cites a file it read five turns ago.
//   - Reuses anti_hallucination_model_config as the checker model so the
//     user only configures one cheap classifier model per agent.

import type { PersistedToolEvent } from "@/lib/stores/threads";
import { getMessages } from "@/lib/stores/threads";
import { getProvider } from "@/lib/providers";
import { getModelConfig, getModelParams } from "@/lib/stores/model-config";

export interface CitationClaim {
  text: string;
  link: string | null;
  verified: boolean;
  reason: string;
}

export interface CitationVerdict {
  checker_model: string;
  claims: CitationClaim[];
  unverified_links: string[];
}

// Tools whose calls/results contribute URLs or file paths to the visited
// set. Anything not on this list is ignored — e.g. memory_read returns
// stored notes, not external sources, so citing a memory hit as a "source"
// shouldn't count as provenance.
const SOURCE_PRODUCING_TOOLS = new Set([
  "file_read", "file_grep", "file_glob", "file_edit", "file_list", "file_stat",
  "file_multi_edit", "file_write",
  "web_search", "fetch_webpage", "web_fetch",
]);

// Strip query/fragment for URLs and normalize backslashes for paths so a
// citation that drops `?utm=...` or uses forward slashes on Windows still
// matches the visited entry.
export function normalizeSource(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, "").toLowerCase();
    } catch {
      return trimmed.toLowerCase();
    }
  }
  return trimmed.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Extract every URL or path referenced by the given tool events. Walks
 * both call payloads (arguments the agent passed, e.g. file_read.path)
 * and result payloads (URLs the search engine returned). Returns a Set
 * of normalized source strings.
 */
export function extractSourcesFromEvents(events: readonly PersistedToolEvent[]): Set<string> {
  const out = new Set<string>();
  for (const ev of events) {
    if (!SOURCE_PRODUCING_TOOLS.has(ev.name)) continue;
    collectStringsFromPayload(ev.payload, out);
  }
  return out;
}

/**
 * Build the per-thread visited-source set: every file path / URL the
 * agent has touched via tool calls across the full thread history,
 * unioned with the just-produced events.
 */
export function extractVisitedSources(
  thread_id: string,
  freshEvents: readonly PersistedToolEvent[],
): Set<string> {
  const out = extractSourcesFromEvents(freshEvents);
  for (const m of getMessages(thread_id)) {
    if (!m.tool_events) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(m.tool_events); } catch { continue; }
    if (!Array.isArray(parsed)) continue;
    const events = parsed.filter((e): e is PersistedToolEvent =>
      !!e && typeof e === "object" && typeof (e as { name?: unknown }).name === "string",
    );
    for (const s of extractSourcesFromEvents(events)) out.add(s);
  }
  return out;
}

/**
 * Pull every markdown link target out of the assistant text. Used to
 * decide whether to even bother calling the checker LLM (no links →
 * no claims to verify → skip the LLM round-trip).
 */
export function extractCitedLinks(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const href = m[1].trim();
    if (href) out.add(href);
  }
  return Array.from(out);
}

const PROMPT_TAIL_BUDGET = 4000;

const SYSTEM_PROMPT = `You judge whether an assistant turn's FACTUAL CLAIMS are backed by SOURCES the agent actually visited in this conversation.

You will receive:
- The assistant text (or its trailing portion).
- A list of source URLs/paths the agent has visited via tools in this thread.

A "factual claim" is a specific assertion about the external world, a file's contents, an API response, or a quoted/paraphrased fact. Generic prose, opinions, plans ("I'll do X"), and conversational filler are NOT claims.

For each claim, look for a markdown link [text](url-or-path) attached to it. The claim is VERIFIED only when:
  (a) such a link is present, AND
  (b) that link (URL or workspace-relative path) is in the visited-sources list.

Reply with EXACTLY one JSON object on one line, no surrounding prose, no markdown fence:

{"claims":[{"text":"<short paraphrase, max 120 chars>","link":"<url-or-null>","verified":true|false,"reason":"<one short sentence, max 120 chars>"}]}

If the turn has no factual claims, return {"claims":[]}.`;

export async function classifyCitations(
  assistantText: string,
  visitedSources: ReadonlySet<string>,
  modelConfigName: string,
  signal?: AbortSignal,
): Promise<CitationVerdict | null> {
  const cfgName = modelConfigName.trim();
  if (!cfgName) return null;
  const cfg = getModelConfig(cfgName);
  if (!cfg) return null;
  const params = getModelParams(cfg);

  let provider;
  try { provider = getProvider(cfg.provider); } catch { return null; }
  if (!provider.invoke) return null;

  // Tail the text so a 60KB turn doesn't blow the checker budget. Citations
  // are usually inline so any sub-window catches representative claims.
  const tail = assistantText.slice(-PROMPT_TAIL_BUDGET);
  const sourcesList = Array.from(visitedSources).slice(0, 200);
  const userMsg = `Visited sources (${sourcesList.length}):
${sourcesList.map((s) => `- ${s}`).join("\n")}

Assistant text (trailing ${tail.length} chars):
${tail}`;

  if (signal?.aborted) return null;
  let result;
  try {
    result = await provider.invoke(
      cfg.model_id,
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
      params,
      [],
    );
  } catch { return null; }

  const parsed = parseCitationVerdict(result?.text ?? "");
  if (!parsed) return null;
  // Apply the visited-set check ourselves rather than trusting the LLM —
  // the LLM is good at extracting claims but not at exact-string membership.
  const claims = parsed.map((c) => {
    const linkNorm = c.link ? normalizeSource(c.link) : "";
    const verified = !!linkNorm && visitedSources.has(linkNorm);
    return { ...c, verified };
  });
  const unverified_links = Array.from(new Set(
    claims.filter((c) => c.link && !c.verified).map((c) => c.link as string),
  ));
  return { checker_model: cfgName, claims, unverified_links };
}

/**
 * Tolerant strict-JSON parser for the checker output. Returns null on any
 * shape mismatch so the caller can degrade to "no metadata".
 */
export function parseCitationVerdict(text: string): CitationClaim[] | null {
  if (!text) return null;
  const stripped = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
  const m = /\{[^]*"claims"[^]*\}/.exec(stripped);
  if (!m) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(m[0]); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const claimsRaw = (parsed as { claims?: unknown }).claims;
  if (!Array.isArray(claimsRaw)) return null;
  const claims: CitationClaim[] = [];
  for (const item of claimsRaw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const text = typeof r.text === "string" ? r.text.slice(0, 200) : "";
    if (!text) continue;
    const link = typeof r.link === "string" && r.link.trim() ? r.link.trim() : null;
    const verified = r.verified === true;
    const reason = typeof r.reason === "string" ? r.reason.slice(0, 200) : "";
    claims.push({ text, link, verified, reason });
  }
  return claims;
}

function collectStringsFromPayload(payload: unknown, out: Set<string>): void {
  if (!payload) return;
  if (typeof payload === "string") {
    const n = normalizeSource(payload);
    if (looksLikeSource(n)) out.add(n);
    return;
  }
  if (Array.isArray(payload)) {
    for (const item of payload) collectStringsFromPayload(item, out);
    return;
  }
  if (typeof payload === "object") {
    for (const v of Object.values(payload as Record<string, unknown>)) {
      collectStringsFromPayload(v, out);
    }
  }
}

function looksLikeSource(s: string): boolean {
  if (!s) return false;
  if (s.startsWith("http://") || s.startsWith("https://")) return true;
  // Workspace-relative paths picked up from file_* tool args/results. Avoid
  // sweeping in every random string by requiring a path separator or a
  // recognisable filename shape (something.ext).
  return s.includes("/") || /\.[a-z0-9]{1,8}$/i.test(s);
}
