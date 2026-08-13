// Bidirectional sync between Jarela's own `memory_store` and Claude Code's
// auto-memory directory (`~/.claude/projects/<encoded-cwd>/memory/*.md`),
// scoped per-workspace. Used as a side effect of `claude_delegate`
// (ADR-0071) — no standalone sync tool or fs.watch mirror, unlike the
// prior external tool this replaces: sync now happens explicitly around
// each delegate call (pull before spawn, push after), so there's no
// loopback HTTP boundary and no need to watch the filesystem for
// out-of-band writes.
//
// Only namespaces matching `claude-sync:*` are eligible — keeps sensitive
// Jarela memory rows out of plain markdown and prevents accidental
// over-sharing into a directory Claude itself can read freely.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { listMemory, putMemory, deleteMemory } from "@/lib/stores/memory";

export const SYNC_NS_PREFIX_RE = /^claude-sync(?::|$)/;
const VALID_MEMORY_TYPES = new Set(["user", "feedback", "project", "reference"]);

export interface ClaudeSyncValue {
  type: string;
  description: string;
  body: string;
  extra_metadata?: Record<string, unknown>;
}

function normalizeProjectPath(cwd: string): string {
  const raw = String(cwd ?? "").trim();
  if (!raw) return path.resolve(raw);
  // Treat explicit Windows drive paths as already-absolute even on POSIX
  // runners, otherwise path.resolve prefixes the current working directory.
  if (/^[A-Za-z]:[\\/]/.test(raw)) {
    const normalized = raw.replace(/\\/g, "/").replace(/\/+$/, "");
    return normalized || raw;
  }
  // Preserve POSIX-style absolute paths verbatim even on Windows so the
  // Claude project directory encoding matches Claude Code's own layout.
  if (raw.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(raw)) {
    return raw.replace(/\/+$/, "") || "/";
  }
  return path.resolve(raw);
}

function encodeClaudeProjectPath(root: string): string {
  const encoded = root.replace(/:/g, "-").replace(/[\\/]/g, "-");
  return encoded.startsWith("-") ? encoded : `-${encoded}`;
}

// Claude Code encodes a project's working directory by replacing every
// path separator with "-", preserving the leading separator, e.g.
// "/Users/andwu/workspace/example-project" -> "-Users-andwu-workspace-example-project".
export function claudeProjectDir(cwd: string): string {
  const root = normalizeProjectPath(cwd);
  const encoded = encodeClaudeProjectPath(root);
  return path.join(os.homedir(), ".claude", "projects", encoded, "memory");
}

// Default per-project namespace: stable, derived from cwd so different
// project trees don't bleed into each other when syncing.
export function namespaceForCwd(cwd: string): string {
  const root = normalizeProjectPath(cwd);
  const hash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 12);
  return `claude-sync:${hash}`;
}

// ── frontmatter ───────────────────────────────────────────────────────────

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  if (s === "") return '""';
  if (/^[\s'"]/.test(s) || /[\n#:]/.test(s) || /\s$/.test(s) || /^[-?&*!|>%@`]/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function stringifyFrontmatter(
  fm: { name: string; description?: string; metadata?: Record<string, unknown> },
  body: string,
): string {
  const lines = ["---"];
  lines.push(`name: ${yamlScalar(fm.name)}`);
  lines.push(`description: ${yamlScalar(fm.description ?? "")}`);
  if (fm.metadata && Object.keys(fm.metadata).length) {
    lines.push("metadata:");
    for (const [k, v] of Object.entries(fm.metadata)) {
      lines.push(`  ${k}: ${yamlScalar(v)}`);
    }
  }
  lines.push("---");
  lines.push("");
  return lines.join("\n") + (body.startsWith("\n") ? body : "\n" + body);
}

function unquoteScalar(v: string): string | null {
  const s = (v ?? "").trim();
  if (s === "" || s === "null") return s === "null" ? null : "";
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      return JSON.parse(s.startsWith("'") ? `"${s.slice(1, -1).replace(/"/g, '\\"')}"` : s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  metadata?: Record<string, string | null>;
  [k: string]: unknown;
}

function parseFrontmatter(content: string): { frontmatter: ParsedFrontmatter; body: string } {
  const text = String(content ?? "");
  if (!text.startsWith("---")) return { frontmatter: {}, body: text };
  const after = text.slice(3).replace(/^\r?\n/, "");
  const endIdx = after.search(/\n---(?:\r?\n|$)/);
  if (endIdx < 0) return { frontmatter: {}, body: text };
  const head = after.slice(0, endIdx);
  let body = after.slice(endIdx).replace(/^\n---(?:\r?\n)?/, "");
  body = body.replace(/^\r?\n/, "");

  const fm: ParsedFrontmatter = {};
  const lines = head.split(/\r?\n/);
  let inMetadata = false;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    if (/^[A-Za-z0-9_-]+:\s*$/.test(raw)) {
      const key = raw.slice(0, raw.indexOf(":")).trim();
      if (key === "metadata") {
        fm.metadata = {};
        inMetadata = true;
      } else {
        inMetadata = false;
      }
      continue;
    }
    if (inMetadata && /^\s+/.test(raw)) {
      const m = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
      if (m) fm.metadata![m[1]] = unquoteScalar(m[2]);
      continue;
    }
    inMetadata = false;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (m) fm[m[1]] = unquoteScalar(m[2]);
  }
  return { frontmatter: fm, body };
}

// ── row <-> file conversion ───────────────────────────────────────────────

export function rowToClaude(key: string, value: ClaudeSyncValue): { filename: string; content: string } {
  const trimmedKey = key.trim();
  if (!trimmedKey) throw new Error("rowToClaude: key is required");
  const type = VALID_MEMORY_TYPES.has(value.type) ? value.type : "user";
  const metadata = { type, ...(value.extra_metadata ?? {}) };
  const content = stringifyFrontmatter(
    { name: trimmedKey, description: value.description ?? "", metadata },
    value.body ?? "",
  );
  return { filename: `${trimmedKey}.md`, content };
}

export function claudeToRow(filename: string, content: string): { key: string; value: ClaudeSyncValue } {
  const base = String(filename ?? "").replace(/\.md$/i, "");
  if (!base) throw new Error("claudeToRow: filename is required");
  const { frontmatter, body } = parseFrontmatter(content);
  const md = frontmatter.metadata ?? {};
  const type = VALID_MEMORY_TYPES.has(md.type ?? "") ? (md.type as string) : "user";
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(md)) {
    if (k !== "type") extra[k] = v;
  }
  const value: ClaudeSyncValue = {
    type,
    description: frontmatter.description ?? "",
    body: body.replace(/\s+$/, ""),
  };
  if (Object.keys(extra).length) value.extra_metadata = extra;
  return { key: base, value };
}

// ── index file ────────────────────────────────────────────────────────────

function titleFromSlug(slug: string): string {
  const cleaned = slug.replace(/[-_]+/g, " ").trim();
  if (!cleaned) return slug;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function buildIndex(entries: Array<{ filename: string; description?: string }>): string {
  const sorted = [...entries].sort((a, b) => a.filename.localeCompare(b.filename));
  return sorted
    .map((e) => {
      const title = titleFromSlug(e.filename.replace(/\.md$/i, ""));
      const hook = (e.description ?? "").split(/\r?\n/, 1)[0].trim();
      return hook ? `- [${title}](${e.filename}) — ${hook}` : `- [${title}](${e.filename})`;
    })
    .join("\n") + "\n";
}

interface MemoryFile {
  filename: string;
  fullPath: string;
  content: string;
  mtimeMs: number;
}

function listMemoryFiles(memDir: string): MemoryFile[] {
  let names: string[];
  try {
    names = readdirSync(memDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.toLowerCase().endsWith(".md") && n !== "MEMORY.md")
    .map((n) => {
      const full = path.join(memDir, n);
      const st = statSync(full);
      return { filename: n, fullPath: full, content: readFileSync(full, "utf8"), mtimeMs: st.mtimeMs };
    });
}

function rewriteIndex(memDir: string): void {
  const files = listMemoryFiles(memDir);
  const entries = files.map((f) => ({
    filename: f.filename,
    description: parseFrontmatter(f.content).frontmatter.description,
  }));
  writeFileSync(path.join(memDir, "MEMORY.md"), buildIndex(entries));
}

// ── sync ──────────────────────────────────────────────────────────────────

function parseMemoryValue(raw: string): ClaudeSyncValue {
  try {
    const parsed = JSON.parse(raw) as Partial<ClaudeSyncValue>;
    return {
      type: typeof parsed.type === "string" ? parsed.type : "user",
      description: typeof parsed.description === "string" ? parsed.description : "",
      body: typeof parsed.body === "string" ? parsed.body : String(raw),
      extra_metadata: parsed.extra_metadata,
    };
  } catch {
    return { type: "user", description: "", body: raw };
  }
}

export interface SyncInResult {
  manifest: Set<string>;
  written: string[];
  skipped: Array<{ key: string; reason: string }>;
  count: number;
}

// Pre-spawn pull: memory store -> Claude's memory dir. Returns the set of
// keys written so a following syncOut in the same run can detect
// deletions on the Claude side (present in manifest, absent from disk).
export function syncIn(cwd: string, namespace: string): SyncInResult {
  if (!SYNC_NS_PREFIX_RE.test(namespace)) {
    throw new Error(`syncIn: namespace must match ${SYNC_NS_PREFIX_RE} (got ${namespace})`);
  }
  const memDir = claudeProjectDir(cwd);
  mkdirSync(memDir, { recursive: true });

  const rows = listMemory(namespace, undefined, 500);
  const manifest = new Set<string>();
  const written: string[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];

  for (const row of rows) {
    manifest.add(row.key);
    const value = parseMemoryValue(row.value);
    const { filename, content } = rowToClaude(row.key, value);
    const target = path.join(memDir, filename);
    const rowMs = Date.parse(row.updated_at || row.created_at || "") || 0;
    let fileMs = 0;
    try { fileMs = statSync(target).mtimeMs; } catch { /* file doesn't exist yet */ }
    if (fileMs && fileMs > rowMs) {
      skipped.push({ key: row.key, reason: "file-newer" });
      continue;
    }
    writeFileSync(target, content);
    written.push(row.key);
  }

  rewriteIndex(memDir);
  return { manifest, written, skipped, count: rows.length };
}

export interface SyncOutResult {
  pushed: string[];
  deleted: string[];
  skipped: Array<{ key: string; reason: string }>;
  count: number;
}

// Post-spawn push: Claude's memory dir -> memory store. `manifest` is the
// set returned by a prior syncIn in the same run; any manifest key missing
// from Claude's dir now is treated as a deletion.
export function syncOut(cwd: string, namespace: string, manifest?: Set<string>): SyncOutResult {
  if (!SYNC_NS_PREFIX_RE.test(namespace)) {
    throw new Error(`syncOut: namespace must match ${SYNC_NS_PREFIX_RE} (got ${namespace})`);
  }
  const memDir = claudeProjectDir(cwd);
  if (!existsSync(memDir)) return { pushed: [], deleted: [], skipped: [], count: 0 };

  const files = listMemoryFiles(memDir);
  const presentKeys = new Set(files.map((f) => f.filename.replace(/\.md$/i, "")));
  const rows = listMemory(namespace, undefined, 500);
  const rowByKey = new Map(rows.map((r) => [r.key, r] as const));

  const pushed: string[] = [];
  const deleted: string[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];

  for (const f of files) {
    const { key, value } = claudeToRow(f.filename, f.content);
    const existing = rowByKey.get(key);
    const rowMs = existing ? Date.parse(existing.updated_at || existing.created_at || "") || 0 : 0;
    if (existing && rowMs >= f.mtimeMs) {
      skipped.push({ key, reason: "row-newer" });
      continue;
    }
    putMemory(namespace, key, value);
    pushed.push(key);
  }

  if (manifest && manifest.size) {
    for (const key of manifest) {
      if (presentKeys.has(key)) continue;
      deleteMemory(namespace, key);
      deleted.push(key);
    }
  }

  rewriteIndex(memDir);
  return { pushed, deleted, skipped, count: files.length };
}
