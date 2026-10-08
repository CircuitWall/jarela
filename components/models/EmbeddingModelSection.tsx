"use client";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { DocumentSettings, ModelConfig } from "@/api/types";
import { computeFeatureReadiness } from "@/lib/ui/feature-readiness";
import { LOCAL_EMBEDDING_CONFIG_NAME, LOCAL_EMBEDDING_MODEL_ID } from "@/lib/embeddings/constants";
import { errorMessage } from "@/lib/utils/error";
import { Select } from "@/components/ui/Select";
import { SettingsCard } from "@/components/ui/SettingsCard";
import { Notice } from "@/components/ui/Notice";

interface EmbeddingProbe {
  ok: boolean;
  provider: string;
  model_id: string;
  dimension?: number;
  error?: string;
}

// One embedding model serves documents, memory, and chat-history recall.
export function EmbeddingModelSection({ models }: { models: ModelConfig[] }) {
  const [embeddingModel, setEmbeddingModel] = useState("__auto__");
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState<EmbeddingProbe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reembed, setReembed] = useState<DocumentSettings["reembed"]>(undefined);

  useEffect(() => {
    let cancelled = false;
    api.documents.getSettings()
      .then((s) => {
        if (cancelled) return;
        setEmbeddingModel(s.embedding_model_config ?? "__auto__");
        setProbe(s.embedding_probe ?? null);
        setReembed(s.reembed);
      })
      .catch((e) => { if (!cancelled) setError(errorMessage(e)); });
    return () => { cancelled = true; };
  }, []);

  // Poll while memory and chat vectors are being rewritten.
  useEffect(() => {
    if (!reembed?.running) return;
    const timer = setInterval(() => {
      api.documents.getSettings().then((s) => setReembed(s.reembed)).catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [reembed?.running]);

  async function save(value: string) {
    setEmbeddingModel(value);
    setSaving(true);
    setProbe(null);
    setError(null);
    try {
      const updated = await api.documents.setSettings({ embedding_model_config: value === "__auto__" ? null : value });
      setEmbeddingModel(updated.embedding_model_config ?? "__auto__");
      setProbe(updated.embedding_probe ?? null);
      setReembed(updated.reembed);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const isLocal = embeddingModel === LOCAL_EMBEDDING_CONFIG_NAME;
  const readiness = computeFeatureReadiness({
    models,
    selectedProvider: isLocal ? "jarela-local" : undefined,
    selectedModelId: isLocal ? LOCAL_EMBEDDING_MODEL_ID : undefined,
    hasLocalEmbeddingModel: true,
  });

  return (
    <SettingsCard
      id="embeddings"
      title="Embeddings"
      description="One model indexes documents and powers memory and chat-history recall. Jarela Local runs on-device, so that text never reaches an embedding provider."
    >
      <Select value={embeddingModel} disabled={saving} onChange={(e) => { void save(e.target.value); }}>
        <option value="__auto__">Auto (best available)</option>
        <option value={LOCAL_EMBEDDING_CONFIG_NAME}>Jarela Local (multilingual, on-device)</option>
        {models.map((m) => (
          <option key={m.name} value={m.name}>{m.name} ({m.provider})</option>
        ))}
      </Select>
      <p className="text-[11px] text-fg-faint">
        Memory and chat vectors are rebuilt automatically after a change. Documents need Reindex on each source.
      </p>
      {saving && <p className="text-[11px] text-fg-faint">Testing embedding model...</p>}
      {!saving && probe && (
        <p className={`text-[11px] ${probe.ok ? "text-emerald-500" : "text-red-400"}`}>
          {probe.ok
            ? `Usable: ${probe.provider}/${probe.model_id}` + (probe.dimension ? ` (${probe.dimension} dims)` : "")
            : `Not usable: ${probe.error ?? "embedding probe failed"}`}
        </p>
      )}
      {!saving && !probe?.ok && !isLocal && !readiness.documentsReady && (
        <Notice tone="warn">Semantic embeddings are not active. Choose Jarela Local or add an embeddings-capable model below.</Notice>
      )}
      {reembed?.running && (
        <Notice tone="info">
          Rebuilding memory and chat vectors for the new model{reembed.total > 0 ? ` (${reembed.done}/${reembed.total})` : ""}…
        </Notice>
      )}
      {!reembed?.running && reembed?.error && (
        <Notice tone="warn">Rebuilding memory and chat vectors paused: {reembed.error}. It retries automatically.</Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </SettingsCard>
  );
}
