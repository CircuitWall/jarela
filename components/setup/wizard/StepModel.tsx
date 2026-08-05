"use client";
import { Info, Plus, ShieldCheck, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import type { ModelConfig } from "@/api/types";
import { api } from "@/api/client";
import { ModelEditor } from "@/components/models/ModelEditor";
import { ProviderLogo } from "@/components/models/ProviderLogo";
import { errorMessage } from "@/lib/utils/error";
import { StepShell } from "./StepShell";

interface StepModelProps {
  models: ModelConfig[];
  onChanged: () => void;
}

export function StepModel({ models, onChanged }: StepModelProps) {
  const [editing, setEditing] = useState<ModelConfig | null | "new">(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(
    name: string,
    data: Omit<ModelConfig, "name" | "created_at" | "updated_at">,
  ) {
    setError(null);
    try {
      if (editing === "new") await api.models.create(name, data);
      else if (editing) await api.models.update(name, data);
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    }
  }

  async function handleSetDefault(m: ModelConfig) {
    try {
      await api.models.update(m.name, {
        provider: m.provider,
        model_id: m.model_id,
        params: m.params,
        is_default: true,
      });
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function handleRemove(name: string) {
    if (!confirm(`Remove model "${name}"?`)) return;
    setError(null);
    try {
      await api.models.delete(name);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <StepShell
      icon={<ShieldCheck size={18} />}
      eyebrow="Step 2 · Connect a model"
      title="Pick the brain that powers your agent"
      description="A model config links Jarela to an LLM provider — Anthropic, OpenAI, Google Gemini, GitHub Copilot, and more. You need at least one before your first agent can think."
    >
      <div className="flex items-start gap-2 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2.5 text-xs text-fg">
        <Info size={14} className="mt-0.5 shrink-0 text-accent" />
        <div className="leading-relaxed">
          <p className="font-medium">First time? Two friendly options:</p>
          <ul className="mt-1 space-y-0.5 text-fg-subtle">
            <li>• <strong>GitHub Copilot</strong> — sign in with your browser, no API key to copy.</li>
            <li>• <strong>Anthropic / OpenAI / Gemini / DeepSeek / Cohere</strong> — paste an API key from the provider&apos;s console.</li>
          </ul>
          <p className="mt-1 text-fg-subtle">You can add more models or change defaults later from Settings → Models.</p>
        </div>
      </div>

      {models.length === 0 ? (
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-border bg-surface-3/40 px-4 py-10 text-sm text-fg-subtle transition-colors hover:border-accent/60 hover:bg-accent/5 hover:text-fg"
        >
          <Plus size={20} />
          <span className="font-medium">Add your first model</span>
          <span className="text-[11px] text-fg-faint">Opens the model editor</span>
        </button>
      ) : (
        <div className="space-y-2">
          {models.map((m) => (
            <div
              key={m.name}
              onClick={() => setEditing(m)}
              className="flex items-center gap-3 rounded-xl border border-border bg-surface-3 px-3 py-2.5 cursor-pointer hover:bg-surface-3/70 transition-colors"
            >
              <span className="shrink-0 text-fg-subtle">
                <ProviderLogo name={m.provider} size={22} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-fg">{m.name}</span>
                  {m.is_default && (
                    <Star
                      size={11}
                      className="shrink-0 fill-yellow-400 text-yellow-700 dark:text-yellow-400"
                    />
                  )}
                  <span className="rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fg-subtle">
                    {m.provider}
                  </span>
                </div>
                <p className="truncate text-[11px] text-fg-faint">{m.model_id}</p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {!m.is_default && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleSetDefault(m); }}
                    className="p-1 text-fg-subtle transition-colors hover:text-yellow-700 dark:hover:text-yellow-400"
                    title="Set as default chat model"
                  >
                    <Star size={13} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleRemove(m.name); }}
                  className="p-1 text-fg-subtle transition-colors hover:text-red-600 dark:hover:text-red-400"
                  title="Remove"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface-3/40 px-4 py-2.5 text-xs text-fg-subtle transition-colors hover:border-fg-faint hover:text-fg"
          >
            <Plus size={14} /> Add another model
          </button>
        </div>
      )}

      {error && (
        <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>
      )}

      {editing !== null && (
        <ModelEditor
          model={editing === "new" ? undefined : editing}
          onSave={handleSave}
          onClose={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </StepShell>
  );
}
