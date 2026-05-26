// Single-file re-index path used by the fs-watch trigger.
//
// The full sweep in indexer.ts handles "scan everything" semantics —
// allowlists, size caps, deletion sweeps. For watcher firings we
// already know the absolute path, so we duplicate just the per-file
// part: stat → read → hash → upsert (or delete).

import { promises as fs } from "node:fs";
import { relative, sep } from "node:path";
import { getDb } from "@/lib/db";
import { getDocumentSource } from "@/lib/stores/document-sources";
import { registerScript } from "@/lib/triggers/scripts";
import {
  ALLOWED_EXT,
  MAX_FILE_BYTES,
  hashContent,
  lowerExt,
  readTextFile,
  upsertLocalDocument,
  type FileEntry,
} from "./indexer";

export interface ReindexResult {
  preview: string;
}

/**
 * Re-index a single file inside a local_folder source. Idempotent;
 * returns "deleted" / "skipped" / "added" / "updated" / "unchanged".
 */
export async function reindexLocalFile(args: {
  source_id: string;
  abs: string;
}): Promise<ReindexResult> {
  const source = getDocumentSource(args.source_id);
  if (!source) return { preview: `skipped: source ${args.source_id} missing` };
  if (source.kind !== "local_folder") {
    return { preview: `skipped: source ${args.source_id} is not local_folder` };
  }

  const db = getDb();

  let stat;
  try {
    stat = await fs.stat(args.abs);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      // File gone — drop the row (chunks cascade via FK).
      const info = db
        .prepare("DELETE FROM documents WHERE source_id=? AND path=?")
        .run(args.source_id, args.abs);
      return {
        preview: info.changes > 0 ? `deleted ${args.abs}` : `skipped: not indexed (${args.abs})`,
      };
    }
    throw err;
  }

  if (!stat.isFile()) return { preview: `skipped: not a regular file (${args.abs})` };
  if (stat.size > MAX_FILE_BYTES) return { preview: `skipped: file > MAX_FILE_BYTES (${args.abs})` };

  // Watchers don't pre-filter by extension as aggressively as the
  // sweep does, so re-check here. Keeps the allowlist as the single
  // source of truth even if a future caller forgets.
  if (!ALLOWED_EXT.has(lowerExt(args.abs))) {
    return { preview: `skipped: ext not allowed (${args.abs})` };
  }

  const text = await readTextFile(args.abs);
  if (text === null) return { preview: `skipped: binary or unreadable (${args.abs})` };

  const hash = hashContent(text);
  const existing = db
    .prepare(
      "SELECT id, mtime_ms, size_bytes, content_hash FROM documents WHERE source_id=? AND path=?",
    )
    .get(args.source_id, args.abs) as
    | { id: string; mtime_ms: number; size_bytes: number; content_hash: string }
    | undefined;

  if (existing && existing.content_hash === hash) {
    // Mtime/size may have shifted (touch / OneDrive sync) but content
    // is unchanged — touch the row instead of re-embedding.
    db.prepare(
      "UPDATE documents SET mtime_ms=?, size_bytes=?, last_indexed_at=? WHERE id=?",
    ).run(Math.floor(stat.mtimeMs), stat.size, new Date().toISOString(), existing.id);
    return { preview: `unchanged ${args.abs}` };
  }

  const f: FileEntry = {
    abs: args.abs,
    rel: relative(source.path, args.abs).split(sep).join("/"),
    mtime_ms: Math.floor(stat.mtimeMs),
    size: stat.size,
  };
  await upsertLocalDocument(args.source_id, f, text, hash, existing?.id);
  return { preview: existing ? `updated ${args.abs}` : `added ${args.abs}` };
}

// Registry side-effect: register the script the fs-watch handler
// emits. Importing this module wires it. Call sites are
// instrumentation.ts (boot) and the fs-watch handler module
// (defensive in case boot order changes).
let registered = false;
export function registerDocumentScripts(): void {
  if (registered) return;
  registerScript("documents.reindex_local_file", async (args) => {
    const sourceId = String(args.source_id ?? "");
    const abs = String(args.abs ?? "");
    if (!sourceId || !abs) {
      return { preview: "skipped: missing source_id or abs" };
    }
    return reindexLocalFile({ source_id: sourceId, abs });
  });
  registered = true;
}

registerDocumentScripts();
