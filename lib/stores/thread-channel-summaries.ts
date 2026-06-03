import { getDb } from "@/lib/db";

// ADR-0044 — per-channel warm summary. One row per (thread_id, channel).
// The pseudo-channel "chat" covers messages with NULL category (ordinary
// user/assistant turns). Other channels mirror messages.category values.
//
// Freshness: a row is fresh iff `summary_before === hot_since` for the
// thread AND no newer message of that channel has landed since
// `computed_at`. Both checks live in history-window assembly — this
// module is a pure store.

export interface ThreadChannelSummaryRow {
  thread_id: string;
  channel: string;
  summary: string;
  summary_before: string | null;
  computed_at: string;
}

const now = () => new Date().toISOString();

export function getChannelSummary(
  thread_id: string,
  channel: string,
): ThreadChannelSummaryRow | null {
  return (
    (getDb()
      .prepare(
        "SELECT thread_id, channel, summary, summary_before, computed_at FROM thread_channel_summaries WHERE thread_id=? AND channel=?",
      )
      .get(thread_id, channel) as ThreadChannelSummaryRow | undefined) ?? null
  );
}

export function listChannelSummaries(thread_id: string): ThreadChannelSummaryRow[] {
  return getDb()
    .prepare(
      "SELECT thread_id, channel, summary, summary_before, computed_at FROM thread_channel_summaries WHERE thread_id=? ORDER BY channel ASC",
    )
    .all(thread_id) as unknown as ThreadChannelSummaryRow[];
}

export function setChannelSummary(
  thread_id: string,
  channel: string,
  summary: string,
  summary_before: string | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO thread_channel_summaries (thread_id, channel, summary, summary_before, computed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(thread_id, channel) DO UPDATE SET
         summary = excluded.summary,
         summary_before = excluded.summary_before,
         computed_at = excluded.computed_at`,
    )
    .run(thread_id, channel, summary, summary_before, now());
}

export function clearChannelSummary(thread_id: string, channel: string): void {
  getDb()
    .prepare("DELETE FROM thread_channel_summaries WHERE thread_id=? AND channel=?")
    .run(thread_id, channel);
}

export function clearAllChannelSummaries(thread_id: string): void {
  getDb()
    .prepare("DELETE FROM thread_channel_summaries WHERE thread_id=?")
    .run(thread_id);
}
