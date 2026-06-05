// Citation checker — second-pass LLM that decides whether the assistant
// turn's factual claims are backed by sources the agent actually visited
// in this thread.
//
// Pipeline:
//   1. extractVisitedSources(threadId)  walks every persisted tool event +
//      the just-produced events to build the {url|path} provenance set.
//   2. buildSourceManifest(visited, max) numbers the most-recent N sources
//      so the model can cite by writing an inline `[N]` marker instead of
//      typing the full path/URL in every claim.
//   3. extractCitedMarkers(text)         pulls every `[N]` marker out of
//      the assistant text so the checker can skip turns that carry no
//      citations at all.
//   4. classifyCitations(text, manifest, modelConfigName) asks the checker
//      LLM to emit a strict-JSON verdict listing each factual claim, the
//      marker the agent attached (if any), and whether that marker is in
//      the manifest.
//
// Failure modes (timeout, parse error, missing model config, provider
// throw) all return null. The caller writes metadata only on a non-null
// verdict and the chat UI degrades to "no badge" when metadata is absent.
//
// Design choices:
//   - Provenance scope is the whole thread, not a rolling window. Matches
//     how focused chat threads work in practice and avoids false flags
//     when the agent legitimately re-cites a file it read five turns ago.
//   - The manifest is built BEFORE the LLM turn (in run-thread) and shown
//     to the model in the system prompt. The model only has to write a
//     small marker `[3]` instead of a full URL — long-form LLM output is
//     much more reliable at emitting short stable tokens than at typing
//     exact paths in the middle of prose.
//   - Reuses anti_hallucination_model_config as the checker model so the
//     user only configures one cheap classifier model per agent.

import type { PersistedToolEvent } from "@/lib/stores/threads";
import { getMessages } from "@/lib/stores/threads";
import { getProvider } from "@/lib/providers";
import { getModelConfig, getModelParams } from "@/lib/stores/model-config";
import { getConfig } from "@/lib/env/config";

export interface CitationClaim {
  text: string;
  marker: number | null;
  link: string | null;
  verified: boolean;
  reason: string;
}

export interface SourceManifestEntry {
  n: number;
  label: string;
  href: string;
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
 * Pull every markdown link target out of the assistant text. Kept for
 * back-compat and as a useful primitive; the new marker-based flow uses
 * extractCitedMarkers instead.
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

/**
 * Pull every numeric marker (`[1]`, `[12]`) out of the assistant text.
 * Skips reference-link tails like `[label][1]` via the lookbehind so the
 * checker doesn't misread accidental markdown reference-link syntax as a
 * citation marker. Returns unique numbers in first-seen order.
 */
export function extractCitedMarkers(text: string): number[] {
  if (!text) return [];
  const out = new Set<number>();
  const re = /(?<!\])\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return Array.from(out);
}

/**
 * Build the numbered source manifest the agent will see in its system
 * prompt. Takes the visited-sources set (insertion-ordered ≈ chronological
 * because both Set and the events that filled it preserve order) and
 * returns the most-recent `max` entries numbered 1..N.
 *
 * Most-recent rather than first-N because old sources are less likely to
 * still be relevant on long threads; a tight cap keeps the prompt cheap.
 */
export function buildSourceManifest(
  visited: ReadonlySet<string>,
  max: number,
): SourceManifestEntry[] {
  if (max <= 0 || visited.size === 0) return [];
  const all = Array.from(visited);
  const tail = all.slice(-max);
  return tail.map((href, i) => ({
    n: i + 1,
    label: labelForSource(href),
    href,
  }));
}

function labelForSource(href: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) {
    try {
      const u = new URL(href);
      const path = u.pathname.replace(/\/$/, "");
      return `${u.hostname}${path}`;
    } catch { return href; }
  }
  return href;
}

const SYSTEM_PROMPT = `You judge whether an assistant turn's FACTUAL CLAIMS are properly cited via SOURCE MARKERS.

You will receive:
- A numbered list of SOURCES the agent visited via tools in this thread.
- The assistant text (or its trailing portion).

The agent cites a source by writing an inline marker like [3] right after the claim, where the number matches a row in the SOURCES list. A marker MAY appear mid-sentence or at the end of a sentence.

A "factual claim" is a specific assertion about the external world, a file's contents, an API response, or a quoted/paraphrased fact. Generic prose, opinions, plans ("I'll do X"), and conversational filler are NOT claims.

For each claim, report:
- "text":     short paraphrase (max 120 chars).
- "marker":   the integer the agent attached (e.g. 3 for [3]), or null if no marker is attached.
- "verified": true if marker is non-null AND that number appears in the SOURCES list, else false.
- "reason":   one short sentence (max 120 chars) explaining the verdict.

Reply with EXACTLY one JSON object on one line, no surrounding prose, no markdown fence:

{"claims":[{"text":"...","marker":<integer-or-null>,"verified":true|false,"reason":"..."}]}

If the turn has no factual claims, return {"claims":[]}.`;

export async function classifyCitations(
  assistantText: string,
  manifest: ReadonlyArray<SourceManifestEntry>,
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
  // JARELA_CITATION_CHECKER_TAIL_CHARS=0 disables truncation entirely (use
  // when claims often appear early in long answers — costs more tokens).
  const tailBudget = getConfig().citationCheckerTailChars;
  const sent = tailBudget > 0 ? assistantText.slice(-tailBudget) : assistantText;
  const portionLabel = tailBudget > 0 && assistantText.length > tailBudget
    ? `trailing ${sent.length} chars of ${assistantText.length}`
    : `full ${sent.length} chars`;
  const sourcesList = manifest.map((e) => {
    const trailer = e.label === e.href ? "" : ` — ${e.href}`;
    return `[${e.n}] ${e.label}${trailer}`;
  }).join("\n");
  const userMsg = `Sources (${manifest.length}):
${sourcesList || "(none)"}

Assistant text (${portionLabel}):
${sent}`;

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
  // Resolve marker → manifest entry ourselves rather than trusting the LLM
  // for the membership decision — the LLM is good at extracting claims but
  // not at exact-integer set membership.
  const byN = new Map(manifest.map((e) => [e.n, e]));
  const claims = parsed.map((c) => {
    const marker = c.marker ?? null;
    const entry = marker !== null ? byN.get(marker) : undefined;
    const link = entry?.href ?? null;
    const verified = entry !== undefined;
    return { ...c, marker, link, verified };
  });
  return { checker_model: cfgName, claims, unverified_links: [] };
}

/**
 * Tolerant strict-JSON parser for the checker output. Returns null on any
 * shape mismatch so the caller can degrade to "no metadata". Parses both
 * `marker` (new manifest-based flow) and `link` (legacy free-form flow).
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
    const markerRaw = r.marker;
    const marker = typeof markerRaw === "number" && Number.isFinite(markerRaw) && markerRaw > 0
      ? Math.floor(markerRaw)
      : null;
    const link = typeof r.link === "string" && r.link.trim() ? r.link.trim() : null;
    const verified = r.verified === true;
    const reason = typeof r.reason === "string" ? r.reason.slice(0, 200) : "";
    claims.push({ text, marker, link, verified, reason });
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
