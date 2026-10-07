"use client";
import type { ModelConfig } from "@/api/types";
import type { EmbeddingProbe } from "./useDocumentsPanel";
import type { computeFeatureReadiness } from "@/lib/ui/feature-readiness";
import { LOCAL_EMBEDDING_CONFIG_NAME } from "@/lib/embeddings/constants";

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
            Jarela Local is bundled for on-device English semantic search. Choose it below to avoid sending document text to an embedding provider.
          </p>
          <p className="mt-1 text-amber-900/90 dark:text-amber-100/90">
            You can also choose a configured OpenAI, Gemini, or GitHub Copilot-backed embedding model in place of Jarela Local.
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
          <option value={LOCAL_EMBEDDING_CONFIG_NAME}>Jarela Local (English, on-device)</option>
          {models.map((m) => (
            <option key={m.name} value={m.name}>{m.name} ({m.provider})</option>
          ))}
        </select>
        <span className="text-[11px] text-fg-faint">
          Changing models does not re-embed automatically. Use Reindex on each local folder to rebuild its vectors.
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
      {!savingEmbeddingModel && !hasWorkingEmbeddingModel && embeddingModel !== LOCAL_EMBEDDING_CONFIG_NAME && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200 leading-snug">
          <p>
            Semantic embeddings are not active yet. Choose Jarela Local above or configure an embeddings-capable provider in Models.
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
