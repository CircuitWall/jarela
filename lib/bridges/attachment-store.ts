// Bridge attachment spill store.
//
// Inbound bridge messages (WhatsApp, future Telegram/Slack, etc.) can
// carry files that are too large or too opaque to inline straight into
// the LLM context: PDFs, spreadsheets, archives, multi-minute audio,
// short videos. We persist those bytes under the user's Jarela data
// dir and hand the agent a text pointer (`saved locally at <abs>`) so
// it can decide what to do — typically calling `file_read` on the path.
//
// Small media (e.g. ≤ 1 MB images) keep going inline so vision-capable
// models can still describe them in one round-trip without bouncing
// through disk.
//
// Layout: <dataDir>/bridge-attachments/<bridge_id>/<YYYY-MM-DD>/<id>-<safe-name>

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getDataDir } from "@/lib/db/data-dir";

export const BRIDGE_ATTACHMENTS_DIRNAME = "bridge-attachments";

/** Default inline cap for media we still want the LLM to see directly. */
export const DEFAULT_INLINE_LIMIT_BYTES = 1 * 1024 * 1024;

/** Media types kept inline when small. Everything else is always spilled. */
export const INLINE_MIME_PREFIXES: readonly string[] = ["image/"];

export interface SaveAttachmentInput {
  bridge_id: string;
  /** Best-effort source filename (may be missing — we'll synthesize one). */
  filename: string | null;
  media_type: string;
  /** Optional adapter-side message id used to make filenames deterministic. */
  message_id?: string | null;
  buffer: Buffer;
}

export interface SavedAttachment {
  abs_path: string;
  size: number;
  sha256: string;
}

/**
 * Decide whether a buffer should be inlined as a `ContentPart` or
 * spilled to disk. Keeps small images inline so vision models still
 * work out-of-the-box; spills everything else.
 */
export function shouldInline(media_type: string, size: number, limit = DEFAULT_INLINE_LIMIT_BYTES): boolean {
  if (size > limit) return false;
  return INLINE_MIME_PREFIXES.some((p) => media_type.startsWith(p));
}

function baseDir(): string {
  return path.join(getDataDir(), BRIDGE_ATTACHMENTS_DIRNAME);
}

function todayDir(): string {
  // Local-time YYYY-MM-DD keeps directories human-scannable in the
  // user's timezone. Cross-day boundary noise isn't worth UTC.
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Strip path separators, control chars, and anything that would
// surprise a Windows shell. Truncate so long captions can't blow
// MAX_PATH (260) on Win32.
function safeFilename(name: string | null, fallback: string): string {
  const raw = (name ?? "").trim() || fallback;
  let s = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 80) {
    const ext = path.extname(s).slice(0, 12);
    s = s.slice(0, 80 - ext.length) + ext;
  }
  return s || fallback;
}

function safeBridgeId(id: string): string {
  // bridge_id is internally generated but be defensive — refuse anything
  // that could escape the attachments dir.
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Persist a bridge attachment to disk and return its absolute path.
 *
 * Idempotent on (bridge_id, message_id, filename): re-saving the same
 * inbound message overwrites the same file rather than fanning out
 * duplicates on adapter restart.
 */
export async function saveBridgeAttachment(input: SaveAttachmentInput): Promise<SavedAttachment> {
  const dir = path.join(baseDir(), safeBridgeId(input.bridge_id), todayDir());
  await fs.mkdir(dir, { recursive: true });

  // Deterministic id when the adapter gave us a message id; fall back
  // to a short random hex so concurrent unrelated messages can't collide.
  const idPart = (input.message_id ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32)
    || crypto.randomBytes(6).toString("hex");
  const fname = `${idPart}-${safeFilename(input.filename, "attachment")}`;
  const abs = path.join(dir, fname);

  await fs.writeFile(abs, input.buffer);

  const sha256 = crypto.createHash("sha256").update(input.buffer).digest("hex");
  return { abs_path: abs, size: input.buffer.length, sha256 };
}

export interface PruneOptions {
  /** Files older than this many ms are deleted. */
  maxAgeMs: number;
}

export interface PruneResult {
  removed_files: number;
  removed_dirs: number;
  freed_bytes: number;
}

/**
 * Delete bridge attachments older than `maxAgeMs`. Best-effort: a
 * locked or vanished file is skipped silently. Empty per-day and
 * per-bridge directories are pruned afterwards so the tree doesn't
 * accumulate empty husks.
 */
export async function pruneBridgeAttachments(opts: PruneOptions): Promise<PruneResult> {
  const root = baseDir();
  const cutoff = Date.now() - Math.max(0, opts.maxAgeMs);
  const result: PruneResult = { removed_files: 0, removed_dirs: 0, freed_bytes: 0 };

  let bridges: string[] = [];
  try { bridges = await fs.readdir(root); } catch { return result; }

  for (const bridge of bridges) {
    const bridgeDir = path.join(root, bridge);
    let days: string[] = [];
    try { days = await fs.readdir(bridgeDir); } catch { continue; }

    for (const day of days) {
      const dayDir = path.join(bridgeDir, day);
      let files: string[] = [];
      try { files = await fs.readdir(dayDir); } catch { continue; }

      for (const f of files) {
        const fp = path.join(dayDir, f);
        try {
          const st = await fs.stat(fp);
          if (!st.isFile()) continue;
          if (st.mtimeMs >= cutoff) continue;
          await fs.unlink(fp);
          result.removed_files++;
          result.freed_bytes += st.size;
        } catch { /* skip */ }
      }

      try {
        const remaining = await fs.readdir(dayDir);
        if (remaining.length === 0) {
          await fs.rmdir(dayDir);
          result.removed_dirs++;
        }
      } catch { /* skip */ }
    }

    try {
      const remaining = await fs.readdir(bridgeDir);
      if (remaining.length === 0) {
        await fs.rmdir(bridgeDir);
        result.removed_dirs++;
      }
    } catch { /* skip */ }
  }

  return result;
}

/** Test helper: absolute path to the root attachments dir. */
export function bridgeAttachmentsRoot(): string {
  return baseDir();
}
