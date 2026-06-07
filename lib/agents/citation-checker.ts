// Citation checker — second-pass LLM that decides whether the assistant
// turn's factual claims are backed by sources the agent actually visited
// in this thread.
//
// Pipeline:
//   1. extractVisitedSources(threadId)  walks every persisted tool event +
//      the just-produced events to build the {url|path} provenance set.
//   2. buildSourceManifest / buildCombinedManifest number the most-recent N
//      sources (tool-visited files/URLs, memory items, prior assistant
//      turns) so the model can cite by writing an inline `[N]` marker
//      instead of typing the full path/URL in every claim.
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
import { listMemory } from "@/lib/stores/memory";
import { isSensitiveMemoryNamespace } from "@/lib/crypto/sensitive";
import { getProvider } from "@/lib/providers";
import { getModelConfig, getModelParams } from "@/lib/stores/model-config";
import { getConfig } from "@/lib/env/config";
import os from "node:os";

export interface CitationClaim {
  text: string;
  marker: number | null;
  link: string | null;
  verified: boolean;
  reason: string;
  /** Load-bearing-ness as judged by the checker. The UI surfaces top-N
   *  claims at `informational` strictness and uses this to colour the
   *  reference panel. */
  impact: "high" | "med" | "low";
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
//
// Split by phase: for listing/search tools (file_list, file_grep,
// file_glob, file_stat) only the CALL args count — the agent visited
// the directory, not every child path the listing returned. Without
// this split, a single `file_list ~/Downloads` floods the manifest with
// 50+ "sources" the agent never opened.
const SOURCE_PRODUCING_TOOLS_CALL = new Set([
  "file_read", "file_edit", "file_multi_edit", "file_write",
  "file_list", "file_grep", "file_glob", "file_stat",
  "web_search", "fetch_webpage", "web_fetch",
]);
const SOURCE_PRODUCING_TOOLS_RESULT = new Set([
  "file_read", "file_edit", "file_multi_edit", "file_write",
  "web_search", "fetch_webpage", "web_fetch",
]);

// Strip query/fragment for URLs and normalize backslashes for paths so a
// citation that drops `?utm=...` or uses forward slashes on Windows still
// matches the visited entry. Also fold `~/...` to the resolved home dir
// so `~/Downloads/x` and `C:\Users\andre\Downloads\x` de-dupe.
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
  let normalized = trimmed.replace(/\\/g, "/");
  if (normalized.startsWith("~/") || normalized === "~") {
    try {
      const home = os.homedir().replace(/\\/g, "/");
      normalized = normalized === "~" ? home : home + normalized.slice(1);
    } catch { /* fall through */ }
  }
  return normalized.replace(/\/+$/, "").toLowerCase();
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
    const allow = ev.phase === "call"
      ? SOURCE_PRODUCING_TOOLS_CALL
      : SOURCE_PRODUCING_TOOLS_RESULT;
    if (!allow.has(ev.name)) continue;
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

/** Public re-export so callers building a manifest outside this module
 *  (e.g. run-thread's post-turn refresh) use the same labeling rules. */
export const labelForCitedSource = labelForSource;

/**
 * Pull prior assistant turns in this thread into citable manifest entries.
 * Used at all strictness levels (when citations are enabled). Each entry's
 * `href` is a `#msg-<id>` anchor the UI can scroll to; the label is a short
 * timestamp ("12m ago") so the agent has something readable to reference.
 *
 * Returns the most-recent `max` assistant turns, oldest-first so a later
 * `buildSourceManifest` call's "tail = recent" semantics keeps stable
 * numbering even as new turns land.
 */
export function extractPriorDialogSources(
  thread_id: string,
  max: number,
): SourceManifestEntry[] {
  if (max <= 0) return [];
  const all = getMessages(thread_id);
  const assistant = all.filter((m) => m.role === "assistant" && (m.content ?? "").trim().length > 0);
  const tail = assistant.slice(-max);
  const nowMs = Date.now();
  return tail.map((m, i) => {
    const ts = Date.parse(m.created_at);
    const ageMs = Number.isFinite(ts) ? Math.max(0, nowMs - ts) : 0;
    return {
      n: i + 1,
      label: `Earlier in thread (${formatAge(ageMs)})`,
      href: `#msg-${m.msg_id}`,
    };
  });
}

function formatAge(ms: number): string {
  if (ms < 60_000) return "just now";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

/**
 * Pull memory items into citable manifest entries. Memory is durable user
 * context (preferences, learned facts, scheduled-task state), so making
 * them citable lets the agent ground answers like "as you mentioned last
 * week, …" with a verifiable reference.
 *
 * Scope: most-recently-updated `max` items across all non-sensitive
 * namespaces. Sensitive namespaces are skipped — `listMemory(undefined)`
 * already decrypts them but exposing them in the system prompt and the
 * UI references panel would defeat the at-rest encryption (ADR-0005).
 */
export function extractMemorySources(max: number): SourceManifestEntry[] {
  if (max <= 0) return [];
  const items = listMemory(undefined, undefined, max);
  return items
    .filter((m) => !isSensitiveMemoryNamespace(m.namespace))
    .map((m, i) => ({
      n: i + 1,
      label: `Memory: ${m.namespace}/${m.key}`,
      href: `memory://${m.namespace}/${m.key}`,
    }));
}

/**
 * Pull every `delegate_to_agent` tool result in the thread into citable
 * manifest entries. The parent agent's reply often paraphrases the
 * delegate's answer ("Postman says today's agenda is …") — without this
 * bucket those claims have no matching source and the agent has nothing
 * legal to cite, so it just omits the marker entirely.
 *
 * Each entry's label is `{delegate_name} replied ({age})`; the href
 * points to the persisted-event anchor inside the parent message so the
 * UI can scroll to the delegate tool card and the user can expand it.
 */
export function extractDelegateSources(
  thread_id: string,
  max: number,
): SourceManifestEntry[] {
  if (max <= 0) return [];
  type DelegateHit = { agent: string; createdAt: string; msgId: string; eventId: string };
  const hits: DelegateHit[] = [];
  for (const m of getMessages(thread_id)) {
    if (!m.tool_events) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(m.tool_events); } catch { continue; }
    if (!Array.isArray(parsed)) continue;
    for (const ev of parsed) {
      if (!ev || typeof ev !== "object") continue;
      const e = ev as { id?: unknown; name?: unknown; phase?: unknown; payload?: unknown };
      if (e.name !== "delegate_to_agent" || e.phase !== "result") continue;
      let payload: unknown = e.payload;
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch { /* keep raw */ }
      }
      const p = (payload && typeof payload === "object") ? payload as Record<string, unknown> : null;
      if (!p || p.ok === false) continue;
      const agent = typeof p.agent_name === "string" ? p.agent_name : "delegate";
      hits.push({
        agent,
        createdAt: m.created_at,
        msgId: m.msg_id,
        eventId: typeof e.id === "string" ? e.id : "",
      });
    }
  }
  const tail = hits.slice(-max);
  const nowMs = Date.now();
  return tail.map((h, i) => {
    const ts = Date.parse(h.createdAt);
    const ageMs = Number.isFinite(ts) ? Math.max(0, nowMs - ts) : 0;
    return {
      n: i + 1,
      label: `${h.agent} replied (${formatAge(ageMs)})`,
      href: `#msg-${h.msgId}`,
    };
  });
}

/**
 * Combine THIS TURN's tool-visited sources + delegate replies + (optional)
 * memory items into one numbered manifest. Caller controls which buckets
 * to include via the per-bucket caps. Numbering is stable within the
 * turn (tools, delegates, memory in that order).
 *
 * Scope is intentionally THIS-TURN-ONLY for tool sources. A reply about
 * iCloud cleanup shouldn't surface the agent's 8-hour-old web_search
 * results for "today's news" — those are visible in their own reply's
 * panel and dragging them across turns drowns the panel in noise the
 * user has to mentally filter every time.
 *
 * Cross-turn signal (prior dialog, memory items) is OPT-IN via the
 * caller's cap setting. Default 0 = don't surface; the agent can still
 * cite earlier turns by writing a markdown link with the `#msg-…` anchor
 * if it genuinely needs to.
 */
export function buildCombinedManifest(
  freshEvents: readonly PersistedToolEvent[],
  thread_id: string,
  caps: { tools: number; memory?: number; delegates?: number },
): SourceManifestEntry[] {
  const toolsSet = extractSourcesFromEvents(freshEvents);
  const tools = buildSourceManifest(toolsSet, caps.tools);
  // Delegate replies from THIS turn only: walk freshEvents for delegate
  // tool-results and emit one entry per successful delegation. Older
  // delegations belong to their own turn's manifest.
  const delegates: SourceManifestEntry[] = [];
  if ((caps.delegates ?? 0) > 0) {
    for (const ev of freshEvents) {
      if (ev.name !== "delegate_to_agent" || ev.phase !== "result") continue;
      let payload: unknown = ev.payload;
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch { /* keep raw */ }
      }
      const p = (payload && typeof payload === "object") ? payload as Record<string, unknown> : null;
      if (!p || p.ok === false) continue;
      const agent = typeof p.agent_name === "string" ? p.agent_name : "delegate";
      const childThread = typeof p.thread_id === "string" ? p.thread_id : "";
      delegates.push({
        n: 0,
        label: `${agent} replied`,
        href: childThread ? `?tab=threads&thread=${childThread}` : "#",
      });
      if (delegates.length >= (caps.delegates ?? 0)) break;
    }
  }
  const memory = (caps.memory ?? 0) > 0 ? extractMemorySources(caps.memory!) : [];
  void thread_id; // currently unused; reserved for future per-thread filters
  const merged = [...tools, ...delegates, ...memory];
  return merged.map((e, i) => ({ ...e, n: i + 1 }));
}

/**
 * Agent-declared references: an optional trailing fenced block
 * ```jarela-references` containing a JSON array of `{label, href}`
 * objects. The block is stripped from the persisted body, and each entry
 * is folded into the source manifest (deduped against tool-derived
 * entries by normalized href).
 *
 * Why: most modern LLMs handle structured side-channels (tool calls,
 * fenced JSON) more reliably than they handle "remember to write [3]
 * after each claim". Letting the agent declare its sources as a small
 * machine-readable list at the end of its reply gives us a high-signal
 * fallback when the agent didn't manage to put every link inline.
 *
 * Forgiving on malformed JSON / missing fields — the agent is allowed
 * to skip the block entirely, and a bad block is silently dropped (the
 * body still renders, just without the declared refs).
 */
const DECLARED_REFS_FENCE_RE = /\n*```jarela-references\s*\n([\s\S]*?)\n```[\s\n]*$/;

export interface DeclaredReference {
  label: string;
  href: string;
}

export function extractDeclaredReferences(
  text: string,
): { body: string; refs: DeclaredReference[] } {
  const m = DECLARED_REFS_FENCE_RE.exec(text);
  if (!m) return { body: text, refs: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    // Malformed JSON: leave the body untouched so the user at least sees
    // what the agent wrote, rather than silently dropping content.
    return { body: text, refs: [] };
  }
  if (!Array.isArray(parsed)) return { body: text, refs: [] };
  const refs: DeclaredReference[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const label = typeof obj.label === "string" ? obj.label.trim() : "";
    const href = typeof obj.href === "string" ? obj.href.trim() : "";
    if (label && href) refs.push({ label, href });
  }
  const body = text.slice(0, m.index).trimEnd();
  return { body, refs };
}

/**
 * Strip an in-progress `jarela-references` fence during streaming so the
 * user never sees raw JSON flash on screen between the opening fence and
 * the closing one. If the closing fence has arrived, defer to the full
 * parser via {@link extractDeclaredReferences}; otherwise cut everything
 * from the opening fence onward.
 */
export function stripStreamingDeclaredReferences(text: string): string {
  if (/```jarela-references[\s\S]*?\n```/.test(text)) {
    return extractDeclaredReferences(text).body;
  }
  const idx = text.indexOf("```jarela-references");
  if (idx < 0) return text;
  return text.slice(0, idx).trimEnd();
}

/**
 * Merge agent-declared refs into an existing manifest. Dedup is by
 * normalized href (same comparison the tool extractor uses), so an agent
 * that declares a URL the manifest already has gets de-duped silently
 * instead of double-listed. New refs are appended after existing ones
 * and renumbered.
 */
export function mergeDeclaredReferences(
  manifest: readonly SourceManifestEntry[],
  declared: readonly DeclaredReference[],
): SourceManifestEntry[] {
  if (declared.length === 0) return [...manifest];
  const seen = new Set(manifest.map((e) => normalizeSource(e.href)));
  const merged = [...manifest];
  for (const d of declared) {
    const key = normalizeSource(d.href);
    if (key && seen.has(key)) continue;
    seen.add(key);
    merged.push({ n: 0, label: d.label, href: d.href });
  }
  return merged.map((e, i) => ({ ...e, n: i + 1 }));
}

const SYSTEM_PROMPT = `You audit an assistant turn and list its FACTUAL CLAIMS, sorted by impact (most load-bearing first).

You will receive:
- A numbered list of SOURCES the agent had available in this thread. Sources may be any of: a tool-visited file/URL, a memory item, or an earlier assistant turn in this thread.
- The assistant text (or its trailing portion).

The agent cites a source by writing an inline marker like [3] right after the claim, where the number matches a row in the SOURCES list. A marker MAY appear mid-sentence or at the end of a sentence.

For each FACTUAL claim — a quoted number, file contents, API behavior, named fact (date, version, person), paraphrased finding, or a recap of a prior turn — emit one entry. IGNORE pure opinion, plans ("I'll do X"), conversational filler, and trivial syntactic glue.

Rank impact:
- "high": load-bearing. The rest of the answer depends on this being right.
- "med":  meaningful but not load-bearing. Wrong would be misleading but not fatal.
- "low":  incidental. Wrong would be a minor blemish.

Sort by impact (high → med → low) within the array. Cap at 15 claims total; if more would qualify, keep the highest-impact 15 and drop the rest.

For each claim, report:
- "text":    short paraphrase of the claim (max 120 chars).
- "marker":  the integer the agent attached (e.g. 3 for [3]), or null if no marker.
- "impact":  one of "high" | "med" | "low".
- "verified": true if marker is non-null AND that number is in the SOURCES list, else false.
- "reason":  one short sentence (max 120 chars) explaining the verdict.

Reply with EXACTLY one JSON object on one line, no surrounding prose, no markdown fence:

{"claims":[{"text":"...","marker":<integer-or-null>,"impact":"high|med|low","verified":true|false,"reason":"..."}]}

If the turn has no factual claims (pure chitchat or plans), return {"claims":[]}.`;

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
  // Stable sort by impact (high → med → low) so callers can slice the
  // top-N for the informational-strictness UI without re-sorting.
  const impactRank: Record<CitationClaim["impact"], number> = { high: 0, med: 1, low: 2 };
  claims.sort((a, b) => impactRank[a.impact] - impactRank[b.impact]);
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
    const impactRaw = typeof r.impact === "string" ? r.impact.toLowerCase() : "";
    const impact: CitationClaim["impact"] =
      impactRaw === "high" ? "high" : impactRaw === "low" ? "low" : "med";
    claims.push({ text, marker, link, verified, reason, impact });
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
  // URLs are bounded, single-line, no whitespace, no JSON syntax. Anything
  // longer than 2048 chars (browser-typical URL cap) is almost certainly a
  // tool-result payload dump and never a real source. Same for strings
  // that contain whitespace, control chars, or look like a JSON literal.
  if (s.length > 2048) return false;
  if (/[\s"'`<>{}]/.test(s)) return false;
  if (s.startsWith("{") || s.startsWith("[")) return false;
  // Asset / binary URLs: images, fonts, stylesheets, scripts, video,
  // audio, archives, favicons. fetch_webpage normalisation surfaces every
  // <img src> on the page; without this filter the references panel
  // drowns under CDN logos and profile thumbnails. Real content sources
  // are HTML or text, not assets.
  const assetExt = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|woff2?|ttf|otf|eot|css|js|mjs|map|mp4|webm|mov|m4v|avi|mkv|mp3|wav|ogg|m4a|flac|zip|tar|gz|rar|7z|pdf|epub)(?:\?|#|$)/i;
  if (assetExt.test(s)) return false;
  // Image-CDN URLs without file extensions: services like dims.apnews.com,
  // images.unsplash.com, cloudinary, imgix, etc. encode transforms into
  // the URL path (`/resize/`, `/crop/`, `/strip/`, `/quality/`, `/fit/`,
  // `/format/`) and serve the rendered bytes off the trailing parameter.
  // No file extension to match — pattern-detect the path segments instead.
  if (/\/(?:resize|crop|strip|quality|fit|format|trim|rotate|scale|smart|w_\d+|h_\d+|c_fill|q_\d+)\//i.test(s)) return false;
  if (s.startsWith("http://") || s.startsWith("https://")) return true;
  // Workspace-relative paths or URI-style refs picked up from file_*
  // tool args/results. Require a real path separator AND that the basename
  // has a recognisable extension. Drop bare directories — `~/Downloads`
  // isn't a citable source, only the files inside it are. This also
  // rejects sentence fragments like "Earlier in thread (7h ago)".
  if (s.startsWith("memory://")) return true;
  const hasFileExt = /\.[a-z0-9]{1,8}$/i.test(s);
  if (s.startsWith("file://")) return hasFileExt;
  if (/^[a-z]:[\\/]/i.test(s)) return hasFileExt;            // C:/ or C:\
  if (s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || s.startsWith("~/")) {
    return hasFileExt;
  }
  // Plain relative path: must contain `/` AND have a file extension.
  return /\//.test(s) && hasFileExt;
}
