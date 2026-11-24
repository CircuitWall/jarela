import { createHash } from "node:crypto";
import { withDbTransaction } from "@/lib/db/transaction";
import {
  deleteMemory,
  getStoredMemoryValue,
  memoryNamespaceCounts,
  putMemory,
  scanMemoryRows,
  type MemoryScanRow,
} from "@/lib/stores/memory";
import { truncateText } from "@/lib/utils/text";
import {
  isMaintainableMemoryNamespace,
  MEMORY_CONTRACT_VERSION,
  MEMORY_FACTS_NAMESPACE,
  MEMORY_KEY_PATTERN,
  MEMORY_MAINTENANCE_EXCLUDED_NAMESPACES,
} from "./contract";
import {
  CURRENT_STRUCTURED_MEMORY_VERSION,
  isStructuredMemoryActive,
  parseStructuredMemory,
  StructuredMemoryInputSchema,
  type StructuredMemoryRecord,
} from "./record";

// Deterministic, code-owned memory maintenance. Everything here works on one
// keyset batch at a time, so cost and memory are proportional to a batch plus
// the bounded group index — never to the size of the whole memory store.
// Model judgment is only needed to choose merged wording for near duplicates;
// expiry, exact duplication, classification and every write guard are code.

export const MEMORY_AUDIT_FINDINGS = [
  "expired",
  "exact_duplicate",
  "near_duplicate",
  "unstructured",
  "invalid",
  "unembedded",
] as const;
export type MemoryAuditFinding = (typeof MEMORY_AUDIT_FINDINGS)[number];

// Configuration and derived/transcript namespaces are owned by other
// subsystems (see ./contract.ts), so the scan filter and the audit share one
// definition.
const SCAN_EXCLUDED_NAMESPACES: readonly string[] = MEMORY_MAINTENANCE_EXCLUDED_NAMESPACES;

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_GROUPS = 20;
const MAX_RECORDS_PER_GROUP = 5;
const MAX_TRACKED_GROUPS = 20_000;
const MAX_NEAR_BUCKETS = 20_000;
const MAX_NEAR_BUCKET_RECORDS = 24;
const UNEMBEDDED_GRACE_MS = 24 * 60 * 60 * 1000;

export const MEMORY_APPLY_MAX_OPERATIONS = 50;
export const MEMORY_BULK_LIMIT_MAX = 500;

export interface MemoryMaintenanceNamespaceRow {
  namespace: string;
  rows: number;
}

export interface MemoryAuditRecordRef {
  namespace: string;
  key: string;
  updated_at: string;
  fingerprint: string;
  kind: string | null;
  subject: string | null;
  status: "active" | "archived" | null;
  confidence: string | null;
  expires_at: string | null;
  chars: number;
  embedded: boolean;
}

export interface MemoryAuditGroup {
  group_id: string;
  finding: MemoryAuditFinding;
  kind: string | null;
  subject: string | null;
  count: number;
  records: MemoryAuditRecordRef[];
  truncated: boolean;
}

export interface MemoryAuditOptions {
  now: string;
  namespace?: string;
  findings?: readonly MemoryAuditFinding[];
  nearDuplicateSimilarity?: number;
  maxGroups?: number;
  cursor?: string | null;
  batchSize?: number;
}

export interface MemoryAuditResult {
  ok: true;
  contract_version: number;
  now: string;
  namespace: string | null;
  scan: {
    scanned_records: number;
    active_records: number;
    archived_records: number;
    namespaces: MemoryMaintenanceNamespaceRow[];
    namespaces_truncated: boolean;
    excluded_rows: number;
    excluded_namespaces: string[];
    truncated: boolean;
  };
  findings: Record<MemoryAuditFinding, { records: number; groups: number }>;
  groups: MemoryAuditGroup[];
  next_cursor: string | null;
  limitation: string;
}

export type MemoryClassification =
  | { status: "structured"; record: StructuredMemoryRecord }
  | { status: "unstructured" }
  | { status: "invalid" };

// Revision marker for compare-and-set writes. Hashing the stored bytes (which
// are ciphertext for sensitive namespaces) keeps the check exact without ever
// needing to decrypt or compare content in the model.
export function memoryFingerprint(updatedAt: string, storedValue: string): string {
  return createHash("sha256").update(`${updatedAt}\n${storedValue}`, "utf8").digest("hex").slice(0, 32);
}

export function classifyMemoryValue(value: unknown): MemoryClassification {
  const record = parseStructuredMemory(value);
  if (record) return { status: "structured", record };
  const parsed = typeof value === "string" ? parseJsonOrSelf(value) : value;
  const looksVersioned = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    && Object.hasOwn(parsed, "version");
  return looksVersioned ? { status: "invalid" } : { status: "unstructured" };
}

function parseJsonOrSelf(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function contentTokens(content: string): Set<string> {
  return new Set(normalizeText(content).split(" ").filter((token) => token.length > 1));
}

function tokenSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a.size <= b.size ? a : b) {
    if (a.size <= b.size ? b.has(token) : a.has(token)) shared += 1;
  }
  return shared / (a.size + b.size - shared);
}

function stableId(finding: string, ...parts: string[]): string {
  return createHash("sha256").update([finding, ...parts].join("\u0000"), "utf8").digest("hex").slice(0, 16);
}

function structuredSignature(record: StructuredMemoryRecord): string {
  return stableId(
    "exact",
    record.kind,
    normalizeText(record.subject),
    normalizeText(record.content),
    record.expires_at ?? "",
  );
}

const CONFIDENCE_RANK: Record<string, number> = { verified: 3, explicit: 2, inferred: 1 };

function confidenceRank(record: StructuredMemoryRecord): number {
  return CONFIDENCE_RANK[record.confidence] ?? 0;
}

function recordRef(row: MemoryScanRow, record: StructuredMemoryRecord | null): MemoryAuditRecordRef {
  return {
    namespace: row.namespace,
    key: row.key,
    updated_at: row.updated_at,
    fingerprint: memoryFingerprint(row.updated_at, row.value),
    kind: record?.kind ?? null,
    subject: record?.subject ?? null,
    status: record?.status ?? null,
    confidence: record?.confidence ?? null,
    expires_at: record?.expires_at ?? null,
    chars: record ? record.content.length : row.value.length,
    embedded: row.embedded,
  };
}

/**
 * Walk every maintainable row in ordered batches. The excluded namespaces are
 * filtered in SQL, so a large transcript archive is never transferred.
 */
export function forEachMaintainableMemoryRow(
  options: { namespace?: string; batchSize?: number },
  visit: (row: MemoryScanRow) => void,
): void {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  let after: { namespace: string; key: string } | null = null;
  for (;;) {
    const batch = scanMemoryRows({
      namespace: options.namespace,
      excludeNamespaces: SCAN_EXCLUDED_NAMESPACES,
      after,
      batchSize,
    });
    for (const row of batch) visit(row);
    if (batch.length < batchSize) return;
    const last = batch[batch.length - 1];
    after = { namespace: last.namespace, key: last.key };
  }
}

interface ExactBucket {
  count: number;
  records: MemoryAuditRecordRef[];
}

interface NearRecord {
  ref: MemoryAuditRecordRef;
  contentKey: string;
  tokens: Set<string>;
}

type GroupState = MemoryAuditGroup;

interface AuditState {
  nowMs: number;
  similarity: number;
  enabled: Set<MemoryAuditFinding> | null;
  counts: Record<MemoryAuditFinding, number>;
  groups: GroupState[];
  groupIndex: Map<string, GroupState>;
  groupCounts: Record<MemoryAuditFinding, number>;
  truncated: boolean;
  scanned: number;
  active: number;
  archived: number;
  exact: Map<string, ExactBucket>;
  exactTruncated: boolean;
  near: Map<string, NearRecord[]>;
}

function createAuditState(options: MemoryAuditOptions): AuditState {
  return {
    nowMs: Date.parse(options.now),
    similarity: options.nearDuplicateSimilarity ?? 0.8,
    enabled: options.findings ? new Set(options.findings) : null,
    counts: { expired: 0, exact_duplicate: 0, near_duplicate: 0, unstructured: 0, invalid: 0, unembedded: 0 },
    groups: [], groupIndex: new Map(),
    groupCounts: { expired: 0, exact_duplicate: 0, near_duplicate: 0, unstructured: 0, invalid: 0, unembedded: 0 },
    truncated: false, scanned: 0, active: 0, archived: 0,
    exact: new Map(), exactTruncated: false, near: new Map(),
  };
}

function findingEnabled(state: AuditState, finding: MemoryAuditFinding): boolean {
  return state.enabled === null || state.enabled.has(finding);
}

function pushGroup(state: AuditState, finding: MemoryAuditFinding, groupId: string, seed: {
  kind: string | null;
  subject: string | null;
}): GroupState {
  const group: GroupState = {
    group_id: groupId, finding, kind: seed.kind, subject: seed.subject,
    count: 0, records: [], truncated: false,
  };
  state.groups.push(group);
  state.groupIndex.set(groupId, group);
  state.groupCounts[finding] += 1;
  return group;
}

function addToGroup(state: AuditState, finding: MemoryAuditFinding, groupId: string, seed: {
  kind: string | null;
  subject: string | null;
}, ref: MemoryAuditRecordRef): void {
  state.counts[finding] += 1;
  if (!findingEnabled(state, finding)) return;
  let group = state.groupIndex.get(groupId);
  if (!group) {
    if (state.groups.length >= MAX_TRACKED_GROUPS) {
      state.truncated = true;
      return;
    }
    group = pushGroup(state, finding, groupId, seed);
  }
  group.count += 1;
  if (group.records.length < MAX_RECORDS_PER_GROUP) group.records.push(ref);
  else group.truncated = true;
}

function trackExact(state: AuditState, signature: string, ref: MemoryAuditRecordRef): void {
  let bucket = state.exact.get(signature);
  if (!bucket) {
    if (state.exact.size >= MAX_TRACKED_GROUPS) {
      state.exactTruncated = true;
      return;
    }
    bucket = { count: 0, records: [] };
    state.exact.set(signature, bucket);
  }
  bucket.count += 1;
  if (bucket.records.length < MAX_RECORDS_PER_GROUP) bucket.records.push(ref);
}

function trackNear(state: AuditState, record: StructuredMemoryRecord, ref: MemoryAuditRecordRef): void {
  if (!findingEnabled(state, "near_duplicate")) return;
  const tokens = contentTokens(record.content);
  if (tokens.size < 3) return;
  const bucketKey = `${record.kind}\u0000${normalizeText(record.subject)}`;
  let bucket = state.near.get(bucketKey);
  if (!bucket) {
    if (state.near.size >= MAX_NEAR_BUCKETS) {
      state.truncated = true;
      return;
    }
    bucket = [];
    state.near.set(bucketKey, bucket);
  }
  if (bucket.length >= MAX_NEAR_BUCKET_RECORDS) {
    state.truncated = true;
    return;
  }
  bucket.push({ ref, contentKey: normalizeText(record.content), tokens });
}

function visitAuditRow(state: AuditState, row: MemoryScanRow): void {
  state.scanned += 1;
  const classification = classifyMemoryValue(row.value);
  if (classification.status !== "structured") {
    const finding = classification.status;
    addToGroup(state, finding, stableId(finding, row.namespace, row.key), {
      kind: null, subject: null,
    }, recordRef(row, null));
    return;
  }
  const record = classification.record;
  const ref = recordRef(row, record);
  if (record.status === "archived") {
    state.archived += 1;
    return;
  }
  state.active += 1;
  if (!row.embedded && state.nowMs - Date.parse(row.updated_at) >= UNEMBEDDED_GRACE_MS) {
    addToGroup(state, "unembedded", stableId("unembedded"), {
      kind: null, subject: "Records without an embedding",
    }, ref);
  }
  if (!isStructuredMemoryActive(record, state.nowMs)) {
    addToGroup(state, "expired", stableId("expired", row.namespace, row.key), {
      kind: record.kind, subject: record.subject,
    }, ref);
    return;
  }
  trackExact(state, structuredSignature(record), ref);
  trackNear(state, record, ref);
}

function materializeExactGroups(state: AuditState): void {
  for (const [signature, bucket] of state.exact) {
    if (bucket.count < 2) continue;
    state.counts.exact_duplicate += bucket.count;
    if (!findingEnabled(state, "exact_duplicate")) continue;
    if (state.groups.length >= MAX_TRACKED_GROUPS) {
      state.truncated = true;
      continue;
    }
    const group = pushGroup(state, "exact_duplicate", stableId("exact-group", signature), {
      kind: bucket.records[0]?.kind ?? null,
      subject: bucket.records[0]?.subject ?? null,
    });
    group.count = bucket.count;
    group.records = bucket.records;
    group.truncated = bucket.count > bucket.records.length;
  }
}

function clusterNear(bucket: NearRecord[], similarity: number): NearRecord[][] {
  const parent = bucket.map((_, index) => index);
  const find = (index: number): number => {
    let cursor = index;
    while (parent[cursor] !== cursor) cursor = parent[cursor];
    return cursor;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  };
  for (let i = 0; i < bucket.length; i++) {
    for (let j = i + 1; j < bucket.length; j++) {
      if (bucket[i].contentKey === bucket[j].contentKey) continue;
      if (tokenSimilarity(bucket[i].tokens, bucket[j].tokens) >= similarity) union(i, j);
    }
  }
  const clusters = new Map<number, NearRecord[]>();
  for (let index = 0; index < bucket.length; index++) {
    const root = find(index);
    const cluster = clusters.get(root) ?? [];
    cluster.push(bucket[index]);
    clusters.set(root, cluster);
  }
  return [...clusters.values()].filter((cluster) => cluster.length > 1);
}

function materializeNearGroups(state: AuditState): void {
  for (const bucket of state.near.values()) {
    for (const cluster of clusterNear(bucket, state.similarity)) {
      state.counts.near_duplicate += cluster.length;
      if (state.groups.length >= MAX_TRACKED_GROUPS) {
        state.truncated = true;
        continue;
      }
      const records = cluster.map((entry) => entry.ref)
        .sort((a, b) => (a.namespace + "\u0000" + a.key).localeCompare(b.namespace + "\u0000" + b.key));
      const ids = records.map((ref) => stableId("near", ref.namespace, ref.key)).sort();
      const group = pushGroup(state, "near_duplicate", stableId("near-group", ids.join("|")), {
        kind: records[0].kind, subject: records[0].subject,
      });
      group.count = records.length;
      group.records = records.slice(0, MAX_RECORDS_PER_GROUP);
      group.truncated = records.length > group.records.length;
    }
  }
}

function sortGroups(groups: GroupState[]): GroupState[] {
  const rank = new Map<string, number>(MEMORY_AUDIT_FINDINGS.map((finding, index) => [finding, index]));
  return [...groups].sort((a, b) => {
    const finding = (rank.get(a.finding) ?? 0) - (rank.get(b.finding) ?? 0);
    if (finding !== 0) return finding;
    if (a.count !== b.count) return b.count - a.count;
    return a.group_id.localeCompare(b.group_id);
  });
}

function parseCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const match = /^v1:(\d{1,9})$/.exec(cursor);
  if (!match) throw new Error("cursor_invalid");
  return Number(match[1]);
}

function namespaceRows(namespace: string | undefined): {
  rows: MemoryMaintenanceNamespaceRow[];
  truncated: boolean;
  excluded: string[];
  excludedRows: number;
} {
  const all = memoryNamespaceCounts().filter((row) => !namespace || row.namespace === namespace);
  const visible = all.filter((row) => isMaintainableMemoryNamespace(row.namespace));
  const excluded = all.filter((row) => !isMaintainableMemoryNamespace(row.namespace));
  return {
    rows: visible.slice(0, 50),
    truncated: visible.length > 50,
    excluded: excluded.map((row) => row.namespace).slice(0, 20),
    excludedRows: excluded.reduce((total, row) => total + row.rows, 0),
  };
}

export function auditMemory(options: MemoryAuditOptions): MemoryAuditResult {
  if (!Number.isFinite(Date.parse(options.now))) throw new Error("now_invalid");
  if (options.namespace && !isMaintainableMemoryNamespace(options.namespace)) throw new Error("namespace_excluded");
  const cursor = parseCursor(options.cursor);
  const maxGroups = Math.min(Math.max(options.maxGroups ?? DEFAULT_MAX_GROUPS, 1), 100);
  const state = createAuditState(options);
  forEachMaintainableMemoryRow(
    { namespace: options.namespace, batchSize: options.batchSize },
    (row) => visitAuditRow(state, row),
  );
  materializeExactGroups(state);
  materializeNearGroups(state);
  const sorted = sortGroups(state.groups);
  const page = sorted.slice(cursor, cursor + maxGroups);
  const namespaces = namespaceRows(options.namespace);
  return {
    ok: true,
    contract_version: MEMORY_CONTRACT_VERSION,
    now: options.now,
    namespace: options.namespace ?? null,
    scan: {
      scanned_records: state.scanned,
      active_records: state.active,
      archived_records: state.archived,
      namespaces: namespaces.rows,
      namespaces_truncated: namespaces.truncated,
      excluded_rows: namespaces.excludedRows,
      excluded_namespaces: namespaces.excluded,
      truncated: state.truncated || state.exactTruncated,
    },
    findings: MEMORY_AUDIT_FINDINGS.reduce((summary, finding) => {
      summary[finding] = { records: state.counts[finding], groups: state.groupCounts[finding] };
      return summary;
    }, {} as Record<MemoryAuditFinding, { records: number; groups: number }>),
    groups: page,
    next_cursor: cursor + maxGroups < sorted.length ? `v1:${cursor + maxGroups}` : null,
    limitation:
      "Read-only snapshot of maintainable namespaces in this one process. Sensitive, settings, advertisement and chat-archive namespaces are excluded. "
      + "Fingerprints pin the exact revision seen; apply rejects changed records. Near-duplicate grouping compares at most "
      + `${MAX_NEAR_BUCKET_RECORDS} records per kind/subject bucket, and group detail is capped at ${MAX_TRACKED_GROUPS}; `
      + "scan.truncated reports when a cap was hit, so a truncated scan is incomplete rather than empty. "
      + "Text matches are candidates only: code cannot prove two differently worded records are equivalent.",
  };
}

export type MemoryMaintenanceOperation =
  | { action: "archive"; namespace: string; key: string; expected_fingerprint: string }
  | { action: "delete"; namespace: string; key: string; expected_fingerprint: string }
  | { action: "upsert"; namespace: string; key: string; expected_fingerprint: string | null; record: unknown }
  | { action: "archive_expired"; limit?: number }
  | { action: "archive_duplicates"; limit?: number };

export interface MemoryMaintenanceOutcome {
  index: number;
  action: MemoryMaintenanceOperation["action"];
  target: string | null;
  status: "applied" | "planned" | "skipped" | "stale" | "failed";
  reason?: string;
  /** Bulk actions only: records changed (or that would change on a dry run). */
  affected?: number;
  /** Bulk actions only: candidates the scan found, before the per-call limit. */
  matched?: number;
  /** Bulk actions only: candidates skipped because they changed during the run. */
  stale?: number;
  keys?: string[];
}

export interface MemoryApplyResult {
  ok: boolean;
  dry_run: boolean;
  applied: number;
  planned: number;
  skipped: number;
  stale: number;
  failed: number;
  outcomes: MemoryMaintenanceOutcome[];
}

export interface MemoryApplyOptions {
  now: string;
  dryRun: boolean;
  operations: readonly MemoryMaintenanceOperation[];
  /**
   * Writes are limited to the canonical `facts` namespace unless the caller
   * opts in. Other namespaces hold legacy user data, but a future subsystem
   * could also store state there, so writing broadly must be deliberate.
   */
  allowNonFactsNamespaces?: boolean;
}

type TargetResolution =
  | { status: "missing" }
  | { status: "stale" }
  | { status: "ok"; classification: MemoryClassification };

function resolveTarget(namespace: string, key: string, expected: string): TargetResolution {
  const stored = getStoredMemoryValue(namespace, key);
  if (!stored) return { status: "missing" };
  if (memoryFingerprint(stored.updated_at, stored.value) !== expected) return { status: "stale" };
  return { status: "ok", classification: classifyMemoryValue(stored.value) };
}

function describeTarget(namespace: string, key: string): string {
  return `${namespace}/${key}`;
}

function canonicalKeyReason(namespace: string, key: string): string | null {
  if (key.length > 200) return "key_too_long";
  if (key.trim().length === 0) return "key_empty";
  if (namespace !== MEMORY_FACTS_NAMESPACE) return null;
  return MEMORY_KEY_PATTERN.test(key) ? null : "key_not_canonical";
}

function writeScopeReason(namespace: string, allowNonFacts: boolean): string | null {
  if (!isMaintainableMemoryNamespace(namespace)) return "namespace_excluded";
  if (namespace !== MEMORY_FACTS_NAMESPACE && !allowNonFacts) return "namespace_requires_opt_in";
  return null;
}

function withoutHistory(record: StructuredMemoryRecord): Record<string, unknown> {
  const { history: _history, ...rest } = record;
  return rest;
}

function archiveStructured(namespace: string, key: string, record: StructuredMemoryRecord): void {
  putMemory(namespace, key, { ...withoutHistory(record), status: "archived" });
}

function runArchive(
  operation: Extract<MemoryMaintenanceOperation, { action: "archive" }>,
  index: number,
  options: MemoryApplyOptions,
): MemoryMaintenanceOutcome {
  const target = describeTarget(operation.namespace, operation.key);
  const scope = writeScopeReason(operation.namespace, options.allowNonFactsNamespaces === true);
  if (scope) {
    return { index, action: operation.action, target, status: "failed", reason: scope };
  }
  const resolved = resolveTarget(operation.namespace, operation.key, operation.expected_fingerprint);
  if (resolved.status === "missing") return { index, action: operation.action, target, status: "skipped", reason: "record_missing" };
  if (resolved.status === "stale") return { index, action: operation.action, target, status: "stale", reason: "record_changed_since_audit" };
  if (resolved.classification.status !== "structured") {
    return { index, action: operation.action, target, status: "failed", reason: "record_is_not_structured_use_upsert_to_convert" };
  }
  if (resolved.classification.record.status === "archived") {
    return { index, action: operation.action, target, status: "skipped", reason: "already_archived" };
  }
  if (options.dryRun) return { index, action: operation.action, target, status: "planned" };
  archiveStructured(operation.namespace, operation.key, resolved.classification.record);
  return { index, action: operation.action, target, status: "applied" };
}

function runDelete(
  operation: Extract<MemoryMaintenanceOperation, { action: "delete" }>,
  index: number,
  options: MemoryApplyOptions,
): MemoryMaintenanceOutcome {
  const target = describeTarget(operation.namespace, operation.key);
  const scope = writeScopeReason(operation.namespace, options.allowNonFactsNamespaces === true);
  if (scope) {
    return { index, action: operation.action, target, status: "failed", reason: scope };
  }
  const resolved = resolveTarget(operation.namespace, operation.key, operation.expected_fingerprint);
  if (resolved.status === "missing") return { index, action: operation.action, target, status: "skipped", reason: "record_missing" };
  if (resolved.status === "stale") return { index, action: operation.action, target, status: "stale", reason: "record_changed_since_audit" };
  if (options.dryRun) return { index, action: operation.action, target, status: "planned" };
  const removed = deleteMemory(operation.namespace, operation.key);
  return removed
    ? { index, action: operation.action, target, status: "applied" }
    : { index, action: operation.action, target, status: "skipped", reason: "record_missing" };
}

function runUpsert(
  operation: Extract<MemoryMaintenanceOperation, { action: "upsert" }>,
  index: number,
  options: MemoryApplyOptions,
): MemoryMaintenanceOutcome {
  const target = describeTarget(operation.namespace, operation.key);
  const scope = writeScopeReason(operation.namespace, options.allowNonFactsNamespaces === true);
  if (scope) {
    return { index, action: operation.action, target, status: "failed", reason: scope };
  }
  const keyReason = canonicalKeyReason(operation.namespace, operation.key);
  if (keyReason) return { index, action: operation.action, target, status: "failed", reason: keyReason };
  const parsed = StructuredMemoryInputSchema.safeParse(operation.record);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      index, action: operation.action, target, status: "failed",
      reason: `invalid_record${issue ? `:${issue.path.join(".") || "record"}` : ""}`,
    };
  }
  const stored = getStoredMemoryValue(operation.namespace, operation.key);
  if (operation.expected_fingerprint === null) {
    if (stored) return { index, action: operation.action, target, status: "failed", reason: "expected_fingerprint_required_for_existing_record" };
  } else if (!stored) {
    return { index, action: operation.action, target, status: "stale", reason: "record_missing" };
  } else if (memoryFingerprint(stored.updated_at, stored.value) !== operation.expected_fingerprint) {
    return { index, action: operation.action, target, status: "stale", reason: "record_changed_since_audit" };
  }
  if (options.dryRun) return { index, action: operation.action, target, status: "planned" };
  const record = parsed.data;
  putMemory(operation.namespace, operation.key, {
    version: CURRENT_STRUCTURED_MEMORY_VERSION,
    ...record,
    summary: record.summary === null ? null : truncateText(record.summary, 280),
  });
  return { index, action: operation.action, target, status: "applied" };
}

interface BulkCandidate {
  namespace: string;
  key: string;
  updated_at: string;
  fingerprint: string;
  record: StructuredMemoryRecord;
}

function bulkLimit(operation: { limit?: number }): number {
  return Math.min(Math.max(operation.limit ?? 100, 1), MEMORY_BULK_LIMIT_MAX);
}

function collectExpired(nowMs: number, limit: number, namespace?: string): {
  candidates: BulkCandidate[];
  matched: number;
  truncated: boolean;
} {
  const candidates: BulkCandidate[] = [];
  let matched = 0;
  forEachMaintainableMemoryRow({ namespace }, (row) => {
    const classification = classifyMemoryValue(row.value);
    if (classification.status !== "structured") return;
    const record = classification.record;
    if (record.status !== "active" || isStructuredMemoryActive(record, nowMs)) return;
    matched += 1;
    if (candidates.length < limit) {
      candidates.push({
        namespace: row.namespace, key: row.key, updated_at: row.updated_at,
        fingerprint: memoryFingerprint(row.updated_at, row.value), record,
      });
    }
  });
  return { candidates, matched, truncated: false };
}

// Deterministic survivor rule for exact duplicates: strongest provenance,
// then most recently updated, then the lexicographically smallest key. Exact
// duplicates carry identical kind/subject/content/expiry, so this needs no
// model judgment.
function compareSurvivor(a: BulkCandidate, b: BulkCandidate): number {
  const confidence = confidenceRank(b.record) - confidenceRank(a.record);
  if (confidence !== 0) return confidence;
  const updated = b.updated_at.localeCompare(a.updated_at);
  if (updated !== 0) return updated;
  return a.key.localeCompare(b.key);
}

function collectDuplicateTargets(nowMs: number, limit: number, namespace?: string): {
  candidates: BulkCandidate[];
  matched: number;
  truncated: boolean;
} {
  const groups = new Map<string, BulkCandidate[]>();
  let truncated = false;
  forEachMaintainableMemoryRow({ namespace }, (row) => {
    const classification = classifyMemoryValue(row.value);
    if (classification.status !== "structured") return;
    const record = classification.record;
    if (record.status !== "active" || !isStructuredMemoryActive(record, nowMs)) return;
    const signature = structuredSignature(record);
    let bucket = groups.get(signature);
    if (!bucket) {
      if (groups.size >= MAX_TRACKED_GROUPS) {
        truncated = true;
        return;
      }
      bucket = [];
      groups.set(signature, bucket);
    }
    if (bucket.length >= 16) {
      truncated = true;
      return;
    }
    bucket.push({
      namespace: row.namespace, key: row.key, updated_at: row.updated_at,
      fingerprint: memoryFingerprint(row.updated_at, row.value), record,
    });
  });
  const candidates: BulkCandidate[] = [];
  let matched = 0;
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    matched += bucket.length - 1;
    if (candidates.length >= limit) continue;
    const ordered = [...bucket].sort(compareSurvivor);
    for (const candidate of ordered.slice(1)) {
      if (candidates.length < limit) candidates.push(candidate);
    }
  }
  return { candidates, matched, truncated };
}

function archiveCandidates(candidates: BulkCandidate[], dryRun: boolean): { archived: string[]; stale: number } {
  const archived: string[] = [];
  let stale = 0;
  for (const candidate of candidates) {
    const stored = getStoredMemoryValue(candidate.namespace, candidate.key);
    if (!stored || memoryFingerprint(stored.updated_at, stored.value) !== candidate.fingerprint) {
      stale += 1;
      continue;
    }
    if (!dryRun) archiveStructured(candidate.namespace, candidate.key, candidate.record);
    archived.push(describeTarget(candidate.namespace, candidate.key));
  }
  return { archived, stale };
}

function runBulk(
  operation: Extract<MemoryMaintenanceOperation, { action: "archive_expired" | "archive_duplicates" }>,
  index: number,
  dryRun: boolean,
  nowMs: number,
  allowNonFacts: boolean,
): MemoryMaintenanceOutcome {
  const limit = bulkLimit(operation);
  const scanNamespace = allowNonFacts ? undefined : MEMORY_FACTS_NAMESPACE;
  const collected = operation.action === "archive_expired"
    ? collectExpired(nowMs, limit, scanNamespace)
    : collectDuplicateTargets(nowMs, limit, scanNamespace);
  const { archived, stale } = archiveCandidates(collected.candidates, dryRun);
  const reason = archived.length < collected.matched
    ? "bulk_limit_reached"
    : collected.truncated ? "scan_truncated" : undefined;
  return {
    index,
    action: operation.action,
    target: null,
    status: dryRun ? "planned" : "applied",
    affected: archived.length,
    matched: collected.matched,
    ...(stale > 0 ? { stale } : {}),
    keys: archived.slice(0, 10),
    ...(reason ? { reason } : {}),
  };
}

function runOperation(operation: MemoryMaintenanceOperation, index: number, options: MemoryApplyOptions): MemoryMaintenanceOutcome {
  const nowMs = Date.parse(options.now);
  const allowNonFacts = options.allowNonFactsNamespaces === true;
  switch (operation.action) {
    case "archive": return runArchive(operation, index, options);
    case "delete": return runDelete(operation, index, options);
    case "upsert": return runUpsert(operation, index, options);
    case "archive_expired":
    case "archive_duplicates": return runBulk(operation, index, options.dryRun, nowMs, allowNonFacts);
  }
}

export function applyMemoryMaintenance(options: MemoryApplyOptions): MemoryApplyResult {
  if (!Number.isFinite(Date.parse(options.now))) throw new Error("now_invalid");
  if (options.operations.length > MEMORY_APPLY_MAX_OPERATIONS) throw new Error("too_many_operations");
  const run = () => options.operations.map((operation, index) => runOperation(operation, index, options));
  const outcomes = options.dryRun ? run() : withDbTransaction(run);
  const totals = { applied: 0, planned: 0, skipped: 0, stale: 0, failed: 0 };
  for (const outcome of outcomes) totals[outcome.status] += 1;
  return { ok: totals.failed === 0, dry_run: options.dryRun, ...totals, outcomes };
}
