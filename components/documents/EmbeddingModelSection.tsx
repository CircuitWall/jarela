"use client";
import type { ModelConfig } from "@/api/types";
import type { EmbeddingProbe } from "./useDocumentsPanel";
import type { computeFeatureReadiness } from "@/lib/ui/feature-readiness";

interface Props {
  models: ModelConfig[];
  embeddingModel: string;
  savingEmbeddingModel: boolean;
  embeddingProbe: EmbeddingProbe | null;
  readiness: ReturnType<typeof computeFeatureReadiness>;
  hasWorkingEmbeddingModel: boolean;
  onSave: (value: string) => void;
  onOpenModels: () => void;
}

export function EmbeddingModelSection(props: Props) {
  const {
    models, embeddingModel, savingEmbeddingModel, embeddingProbe,
    readiness, hasWorkingEmbeddingModel, onSave, onOpenModels,
  } = props;

  return (
    <section className="space-y-2">
      <label className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Embedding model</label>
      {!readiness.documentsReady && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200 leading-snug">
          <p>
            Documents need an embeddings-capable model that this installation can already use. Add one in Models if semantic recall is important.
          </p>
          <p className="mt-1 text-amber-900/90 dark:text-amber-100/90">
            Compatible setup: OpenAI, Gemini, and GitHub Copilot-backed setups are the main built-in paths here. If none is available, Documents falls back to substring search only.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onOpenModels}
              className="rounded-md border border-amber-600/30 bg-white/50 px-2 py-1 text-[11px] font-medium text-amber-900 dark:bg-black/10 dark:text-amber-100"
            >
              Open Models
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          value={embeddingModel}
          onChange={(e) => onSave(e.target.value)}
          disabled={savingEmbeddingModel}
          className="px-2 py-1.5 rounded-md bg-surface-2 border border-border text-xs text-fg disabled:opacity-60"
        >
          <option value="__auto__">Auto (best available)</option>
          {models.map((m) => (
            <option key={m.name} value={m.name}>{m.name} ({m.provider})</option>
          ))}
        </select>
        <span className="text-[11px] text-fg-faint">
          Used for document chunk embeddings. Rescan applies this to all eligible chunks.
        </span>
      </div>
      {savingEmbeddingModel && (
        <p className="text-[11px] text-fg-faint">Testing embedding model...</p>
      )}
      {!savingEmbeddingModel && embeddingProbe && (
        <p className={`text-[11px] ${embeddingProbe.ok ? "text-emerald-500" : "text-red-400"}`}>
          {embeddingProbe.ok
            ? `Usable: ${embeddingProbe.provider}/${embeddingProbe.model_id}` +
              (embeddingProbe.dimension ? ` (${embeddingProbe.dimension} dims)` : "")
            : `Not usable: ${embeddingProbe.error ?? "embedding probe failed"}`}
        </p>
      )}
      {!savingEmbeddingModel && models.length > 0 && !hasWorkingEmbeddingModel && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200 leading-snug">
          <p>
            Current model setup does not appear ready for semantic document search yet. Add or switch to a model/provider with embeddings support in Models, then rescan your sources.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onOpenModels}
              className="rounded-md border border-amber-600/30 bg-white/50 px-2 py-1 text-[11px] font-medium text-amber-900 dark:bg-black/10 dark:text-amber-100"
            >
              Fix in Models
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
