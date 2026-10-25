"use client";
import { useState } from "react";
import type { DocumentRecallPolicy } from "@/lib/documents/recall-policy";

interface Props {
  policy: DocumentRecallPolicy;
  onSave: (policy: DocumentRecallPolicy) => Promise<void>;
}

export function RecallExclusions({ policy, onSave }: Props) {
  const [topics, setTopics] = useState(policy.topics.join("\n"));
  const [similarity, setSimilarity] = useState(policy.topic_similarity);
  const [saving, setSaving] = useState(false);

  async function save(next: DocumentRecallPolicy) {
    setSaving(true);
    try {
      await onSave(next);
    } catch {
      // The panel surfaces save errors.
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Global recall exclusions</h3>
      <p className="text-xs text-fg-faint">
        Applies to all indexed sources and assistant document searches, including existing content.
        Topic matching is best-effort; exclude individual documents below for exact control.
        This does not delete content, prevent external embedding, remove prior chat excerpts, or block live tools.
      </p>
      <label className="block text-xs text-fg-muted">
        Excluded topics (one per line, up to 25)
        <textarea aria-label="Excluded topics" value={topics} disabled={saving}
          onChange={(e) => setTopics(e.target.value)}
          placeholder={"Personal medical treatment\nProject Atlas"}
          rows={3} className="mt-1 w-full rounded-md bg-surface-2 border border-border p-2 text-sm text-fg" />
      </label>
      <label className="flex items-center gap-2 text-xs text-fg-muted">
        Topic similarity threshold
        <input aria-label="Topic similarity threshold" type="number" min={0.1} max={1} step={0.05}
          value={similarity} disabled={saving} onChange={(e) => setSimilarity(e.target.valueAsNumber)}
          className="w-20 rounded-md bg-surface-2 border border-border p-1" />
      </label>
      <p className="text-xs text-fg-faint">
        Lower thresholds exclude more. Preview results to tune this; similarity cannot guarantee topic detection.
        When topic filtering cannot run, assistant document search is blocked instead of returning unchecked content.
        Topic descriptions use your selected embedding provider.
      </p>
      <button type="button" disabled={saving || !Number.isFinite(similarity) || similarity < 0.1 || similarity > 1}
        onClick={() => void save({
          ...policy, topics: [...new Set(topics.split("\n").map((t) => t.trim()).filter(Boolean))],
          topic_similarity: similarity,
        })}
        className="text-xs text-accent disabled:opacity-50">
        {saving ? "Saving..." : "Save topic exclusions"}
      </button>
      {policy.excluded_documents.map((doc) => (
        <div key={`${doc.source_id}:${doc.path}`} className="flex gap-2 items-center text-xs text-fg-muted">
          <span className="truncate flex-1">{doc.label}</span>
          <button type="button" disabled={saving} className="text-accent"
            onClick={() => void save({
              ...policy, excluded_documents: policy.excluded_documents.filter(
                (d) => d.source_id !== doc.source_id || d.path !== doc.path,
              ),
            })}>Allow again</button>
        </div>
      ))}
    </section>
  );
}
