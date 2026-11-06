// Citation source-manifest and verdict parsing helpers. The unified
// action-evidence classifier owns the model call and resolves markers
// against the same manifest that is persisted with the result.

import type { PersistedToolEvent } from "@/lib/stores/threads";
import { listMemory } from "@/lib/stores/memory";
import { isSensitiveMemoryNamespace } from "@/lib/crypto/sensitive";
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

const TRACKING_PARAM_RE = /^(?:utm(?:_.*)?|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src)$/i;

// Drop tracking params and in-page anchors for URLs and normalize
// backslashes for paths so a citation that adds `?utm_source=...` or uses
// forward slashes on Windows still matches the visited entry. Identifying
// query params (Outlook `?ItemID=`, `watch?v=`) and hash routes (Gmail
// `#all/<id>`) are kept verbatim: they are case-sensitive and are the only
// thing that distinguishes two message permalinks. Also fold `~/...` to the
// resolved home dir so `~/Downloads/x` and `C:\Users\andre\Downloads\x` de-dupe.
export function normalizeSource(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      const base = `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, "").toLowerCase();
      const params = [...u.searchParams]
        .filter(([key]) => !TRACKING_PARAM_RE.test(key))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
      const hashRoute = u.hash.includes("/") ? u.hash : "";
      return base + query + hashRoute;
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
 * Pull every inline Markdown link destination (`[label](href)`) out of the
 * assistant text, normalized the same way manifest hrefs are. The drafting
 * prompt's PRIMARY citation format is an inline link, not a `[n]` bracket
 * marker — a claim backed by one never contains literal bracket text, so
 * checking "is this source's href one the reply actually links to" is the
 * citation-format-agnostic counterpart to `extractCitedMarkers`.
 */
export function extractInlineLinkHrefs(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const re = /\]\(([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const normalized = normalizeSource(m[1]);
    if (normalized) out.add(normalized);
  }
  return out;
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

/**
 * Tolerant strict-JSON parser for the checker output. Returns null on any
 * shape mismatch so the caller can degrade to "no metadata". Parses both
 * `marker` (new manifest-based flow) and `link` (legacy free-form flow).
 */
export function parseCitationVerdict(text: string): CitationClaim[] | null {
  if (!text) return null;
  const stripped = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
  const parsed = findClaimsObject(stripped);
  if (!parsed) return null;
  const claimsRaw = parsed.claims;
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

// Models often wrap the verdict in prose that itself contains braces, so a
// single greedy `{...}` match can start or end in the wrong place. Try each
// `{` as a start and parse the balanced object it opens (string-aware).
function findClaimsObject(text: string): { claims?: unknown } | null {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const end = balancedObjectEnd(text, start);
    if (end === -1) continue;
    const candidate = text.slice(start, end + 1);
    if (!candidate.includes('"claims"')) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && "claims" in parsed) return parsed as { claims?: unknown };
    } catch { /* try the next opening brace */ }
  }
  return null;
}

function balancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
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
