import { transcriptText, type SummaryTopicFact, type SummaryTopicSegment } from "@/lib/agents/conversation-summary";
import type { PersistedToolEvent } from "@/lib/stores/threads";

// Deterministic half of warm-context compaction. The summarizer model only
// segments and recaps; everything that can be checked or computed in code —
// message counts, which topic a saved memory belongs to, merging into the
// stored topics, and fading out the oldest ones — lives here.

export interface WarmTopicSourceRow {
  seq: number;
  content: string;
  tool_events?: string | null;
}

const MAX_TOPIC_FACTS = 16;
const MEMORY_WRITE_NAMESPACES = new Set(["facts"]);

/** Stable id the compaction pipeline uses to refer to stored topic `index`. */
export function warmTopicId(index: number): string {
  return `t${index + 1}`;
}

function rowsInRange<T extends WarmTopicSourceRow>(rows: readonly T[], topic: SummaryTopicSegment): T[] {
  return rows.filter((row) => row.seq >= (topic.start_seq ?? Infinity) && row.seq <= (topic.end_seq ?? -Infinity));
}

// Unicode-aware so non-Latin subjects get distinct keys; an ASCII-only slug
// collapsed them all to "" and the uplift skipped them. Subjects with no
// letters or digits fall back to a stable hash.
export function slugifyForMemoryKey(subject: string): string {
  const slug = subject
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const capped = Array.from(slug).slice(0, 80).join("").replace(/-+$/, "");
  return capped || `fact-${fnv1a(subject)}`;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Merge facts by subject (case-insensitive) and memory key. Later entries win,
 * so callers pass the newer or more trustworthy list last. Keeps the newest
 * MAX_TOPIC_FACTS.
 */
export function mergeTopicFacts(...lists: readonly (readonly SummaryTopicFact[])[]): SummaryTopicFact[] {
  const merged = new Map<string, SummaryTopicFact>();
  const keyToSubject = new Map<string, string>();
  for (const list of lists) {
    for (const fact of list) {
      const subjectId = fact.subject.trim().toLowerCase();
      const sameKeySubject = fact.key ? keyToSubject.get(fact.key) : undefined;
      for (const replaced of [sameKeySubject, subjectId]) {
        if (replaced === undefined) continue;
        // Drop the replaced fact's key mapping too, so a later fact reusing
        // that key cannot delete whatever now lives under this subject.
        const previousKey = merged.get(replaced)?.key;
        if (previousKey) keyToSubject.delete(previousKey);
        merged.delete(replaced);
      }
      merged.set(subjectId, fact);
      if (fact.key) keyToSubject.set(fact.key, subjectId);
    }
  }
  return [...merged.values()].slice(-MAX_TOPIC_FACTS);
}

/**
 * A topic must span at least two messages. Fold any single-message topic into
 * the previous topic (or the next one when it is first). Input must be the
 * ordered, non-overlapping output of validateTopicSegments.
 */
export function foldSingleMessageTopics(
  topics: readonly SummaryTopicSegment[],
  rows: readonly WarmTopicSourceRow[],
): SummaryTopicSegment[] {
  const out = topics.map((topic) => ({ ...topic, facts: [...topic.facts] }));
  let index = 0;
  while (out.length > 1 && index < out.length) {
    if (rowsInRange(rows, out[index]).length >= 2) {
      index += 1;
      continue;
    }
    const single = out[index];
    const targetIndex = index > 0 ? index - 1 : 1;
    const target = out[targetIndex];
    const [first, second] = targetIndex < index ? [target, single] : [single, target];
    out[targetIndex] = {
      ...target,
      start_seq: first.start_seq,
      start_at: first.start_at,
      partial_start: first.partial_start,
      end_seq: second.end_seq,
      end_at: second.end_at,
      recap: targetIndex < index ? `${target.recap} ${single.recap}` : `${single.recap} ${target.recap}`,
      facts: mergeTopicFacts(target.facts, single.facts),
      continues: target.continues ?? single.continues,
    };
    out.splice(index, 1);
    if (targetIndex < index) index = targetIndex;
  }
  return out;
}

function toolResultText(payload: unknown): string | null {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  if (obj.__truncated) return null;
  const kwargs = obj.kwargs as Record<string, unknown> | undefined;
  if (typeof kwargs?.content === "string") return kwargs.content;
  if (typeof obj.content === "string") return obj.content;
  return JSON.stringify(obj);
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function unwrapCall(event: PersistedToolEvent): { name: string; args: Record<string, unknown> } | null {
  const payload = parseObject(event.payload);
  if (!payload) return null;
  if (event.name !== "invoke_tool") return { name: event.name, args: payload };
  const name = typeof payload.name === "string" ? payload.name : "";
  const args = parseObject(payload.args_json) ?? parseObject(payload.args) ?? {};
  return name ? { name, args } : null;
}

function savedFactFromCall(name: string, args: Record<string, unknown>, key: string): SummaryTopicFact | null {
  const namespace = typeof args.namespace === "string" ? args.namespace : "";
  if (name === "memory_upsert") {
    const record = parseObject(args.record) ?? {};
    const subject = typeof record.subject === "string" && record.subject.trim() ? record.subject.trim() : key;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    const confidence = record.confidence === "explicit" || record.confidence === "inferred" || record.confidence === "verified"
      ? record.confidence
      : "explicit";
    const tags = Array.isArray(record.tags) ? record.tags.filter((t): t is string => typeof t === "string").slice(0, 16) : [];
    return { subject: subject.slice(0, 160), content: content.slice(0, 1_000), tags, confidence, key: `${namespace}/${key}`, origin: "agent" };
  }
  if (name === "memory_write" && MEMORY_WRITE_NAMESPACES.has(namespace)) {
    const value = typeof args.value === "string" ? args.value.trim() : "";
    return { subject: key, content: value.slice(0, 1_000), tags: [], confidence: "explicit", key: `${namespace}/${key}`, origin: "agent" };
  }
  return null;
}

/**
 * Memory records the agent saved in a message, verified by the tool result
 * (`ok: true` echoing the same key). Unverified or failed writes are skipped.
 */
export function savedMemoryFacts(row: WarmTopicSourceRow): SummaryTopicFact[] {
  if (!row.tool_events) return [];
  let events: PersistedToolEvent[];
  try {
    const parsed = JSON.parse(row.tool_events) as unknown;
    if (!Array.isArray(parsed)) return [];
    events = parsed as PersistedToolEvent[];
  } catch {
    return [];
  }
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const event of events) {
    if (event?.phase !== "call") continue;
    const call = unwrapCall(event);
    if (call && (call.name === "memory_upsert" || call.name === "memory_write")) calls.set(event.id, call);
  }
  const facts: SummaryTopicFact[] = [];
  for (const event of events) {
    if (event?.phase !== "result") continue;
    const call = calls.get(event.id);
    if (!call) continue;
    const text = toolResultText(event.payload);
    let result = text ? parseObject(text) : null;
    if (result && typeof result.result === "string") result = parseObject(result.result) ?? result;
    const key = typeof call.args.key === "string" ? call.args.key : "";
    if (!result || result.ok !== true || !key || (typeof result.key === "string" && result.key !== key)) continue;
    const fact = savedFactFromCall(call.name, call.args, key);
    if (fact) facts.push(fact);
  }
  return facts;
}

/**
 * Attach the code-derived fields to one topic: message count and size of the
 * rows it covers, keys for extracted facts, and memory the agent saved there.
 */
export function finalizeTopic(
  topic: SummaryTopicSegment,
  covered: readonly WarmTopicSourceRow[],
): SummaryTopicSegment {
  const extracted = topic.facts.map((fact): SummaryTopicFact => ({
    ...fact,
    key: fact.key ?? `facts/${slugifyForMemoryKey(fact.subject)}`,
    origin: fact.origin ?? "compaction",
  }));
  return {
    ...topic,
    facts: mergeTopicFacts(extracted, covered.flatMap(savedMemoryFacts)),
    message_count: covered.length,
    source_chars: covered.reduce((total, row) => total + transcriptText(row.content).length, 0),
  };
}

/**
 * Turn validated summarizer topics into stored topics: fold single-message
 * topics, then finalize each against the rows in its seq range.
 */
export function finalizeFreshTopics(
  topics: readonly SummaryTopicSegment[],
  rows: readonly WarmTopicSourceRow[],
): SummaryTopicSegment[] {
  return foldSingleMessageTopics(topics, rows).map((topic) => finalizeTopic(topic, rowsInRange(rows, topic)));
}

/** Stored topics can be extended incrementally only when every one carries its message count and seq range. */
export function canMergeIntoTopics(
  prior: readonly SummaryTopicSegment[] | null | undefined,
  priorBeforeSeq: number | null | undefined,
  boundarySeq: number,
): prior is SummaryTopicSegment[] {
  if (!prior || prior.length === 0 || priorBeforeSeq == null || boundarySeq <= priorBeforeSeq) return false;
  return prior.every((topic) =>
    Number.isSafeInteger(topic.start_seq)
    && Number.isSafeInteger(topic.end_seq)
    && topic.end_seq! < priorBeforeSeq
    && typeof topic.message_count === "number"
    && Array.isArray(topic.facts),
  );
}

/** Model-facing text for stored topics: one heading per topic, its recap, and the memory keys it produced. */
export function renderTopicRecaps(topics: readonly SummaryTopicSegment[]): string {
  return topics.map((topic) => {
    const memorized = topic.facts.flatMap((fact) => fact.key ? [fact.key] : []);
    return [
      `### ${topic.title}${topic.partial_start ? " (partial; earlier messages omitted)" : ""}`,
      topic.recap,
      ...(memorized.length > 0 ? [`Memorized: ${memorized.join(", ")}`] : []),
    ].join("\n");
  }).join("\n\n");
}

export interface MergedWarmTopics {
  topics: SummaryTopicSegment[];
  sourceMessages: number;
  sourceChars: number;
  evicted: number;
}

/**
 * Fold fresh topics into the stored ones, newest last. A fresh topic that
 * `continues` a stored one updates it in place (newer recap, merged facts,
 * summed counts). Then the least recently active topics fade out until the
 * kept topics fit `messageLimit`, mirroring how memory keeps recent detail.
 * Their facts already live in the memory store, so eviction loses no record.
 */
export function mergeWarmTopics(
  prior: readonly SummaryTopicSegment[],
  fresh: readonly SummaryTopicSegment[],
  messageLimit: number,
): MergedWarmTopics {
  const out: SummaryTopicSegment[] = prior.map((topic) => ({ ...topic, facts: [...topic.facts] }));
  const indexById = new Map(prior.map((_, index) => [warmTopicId(index), index]));
  for (const topic of fresh) {
    const { continues, ...clean } = topic;
    const index = continues ? indexById.get(continues) : undefined;
    if (index === undefined) {
      out.push(clean);
      continue;
    }
    const base = out[index];
    out[index] = {
      ...base,
      title: clean.title,
      end_seq: clean.end_seq,
      end_at: clean.end_at,
      recap: clean.recap,
      facts: mergeTopicFacts(base.facts, clean.facts),
      message_count: (base.message_count ?? 0) + (clean.message_count ?? 0),
      source_chars: (base.source_chars ?? 0) + (clean.source_chars ?? 0),
    };
  }
  out.sort((a, b) => (a.end_seq ?? 0) - (b.end_seq ?? 0));

  let total = out.reduce((sum, topic) => sum + (topic.message_count ?? 0), 0);
  let evicted = 0;
  while (out.length > 1 && total > messageLimit) {
    total -= out[0].message_count ?? 0;
    out.shift();
    evicted += 1;
  }
  return {
    topics: out,
    // The warm cache treats a count above the limit as an oversized legacy
    // summary and rebuilds it; one topic larger than the limit is still a
    // bounded, merged recap, so report it at the limit.
    sourceMessages: Math.min(total, messageLimit),
    sourceChars: out.reduce((sum, topic) => sum + (topic.source_chars ?? 0), 0),
    evicted,
  };
}
