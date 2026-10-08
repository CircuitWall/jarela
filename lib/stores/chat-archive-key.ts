// Namespace + key helpers for chat_archive memory_store rows. Pulled into
// its own module (rather than living in `threads.ts`) to break what would
// otherwise be a circular import between `lib/stores/threads.ts` and
// `lib/embeddings/index.ts` — the former needs the constants to write a
// row during prune, the latter needs them to recognise archive rows
// inside recall(). Separating the pure helpers lets both sides depend on
// this leaf module without pulling each other in.

// Namespace under which pruned chat messages are archived into memory_store
// before the row is deleted. recall() recognises this namespace and emits
// the archived row as a `source: "message"` hit so it renders through the
// existing "past chat" / "earlier this thread" formatting in
// buildRecallContext — exactly like a live message row, except the backing
// messages row is gone.
export const CHAT_ARCHIVE_NAMESPACE = "chat_archive";

// Encodes the pruned message's role, thread_id, and msg_id into a single
// memory_store key so recall() can parse them back without storing them
// twice. "::" is used as a separator because role is a small, closed set
// ("user"|"assistant"|"system"|"tool") that never contains it, and
// thread/msg ids are UUIDs that don't either.
export function makeChatArchiveKey(role: string, thread_id: string, msg_id: string): string {
  return `${role}::${thread_id}::${msg_id}`;
}

export function parseChatArchiveKey(key: string): { role: string; thread_id: string; msg_id: string } | null {
  const parts = key.split("::");
  if (parts.length !== 3) return null;
  const [role, thread_id, msg_id] = parts;
  if (!role || !thread_id || !msg_id) return null;
  return { role, thread_id, msg_id };
}
