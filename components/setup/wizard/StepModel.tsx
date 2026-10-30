"use client";
import { Info, Plus, ShieldCheck, Star, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ModelConfig } from "@/api/types";
import { api } from "@/api/client";
import { ModelEditor } from "@/components/models/ModelEditor";
import { ProviderLogo } from "@/components/models/ProviderLogo";
import { errorMessage } from "@/lib/utils/error";
import { StepShell } from "./StepShell";

import { confirmAction } from "@/lib/ui/confirm";

interface StepModelProps {
  models: ModelConfig[];
  onChanged: () => void;
  readOnly?: boolean;
  defaultProvider?: string;
}

export function StepModel({ models, onChanged, readOnly = false, defaultProvider }: StepModelProps) {
  const [editing, setEditing] = useState<ModelConfig | null | "new">(null);
  const [error, setError] = useState<string | null>(null);
  const autoOpened = useRef(false);
  const hasEnabledModel = models.some((model) => model.enabled !== false);

  useEffect(() => {
    if (readOnly || hasEnabledModel || !defaultProvider || autoOpened.current) return;
    autoOpened.current = true;
    setEditing("new");
  }, [defaultProvider, hasEnabledModel, readOnly]);

  async function handleSave(
    name: string,
    data: Omit<ModelConfig, "name" | "enabled" | "created_at" | "updated_at">,
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
      await api.models.patch(m.name, { is_default: true });
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function handleRemove(name: string) {
    if (!(await confirmAction({ message: `Remove model "${name}"?`, destructive: true, confirmLabel: "Remove" }))) return;
    setError(null);
    try {
      await api.models.delete(name);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (readOnly) {
    return <ModelReview models={models} />;
  }

  return (
    <ModelSetup
      models={models}
      defaultProvider={defaultProvider}
      hasEnabledModel={hasEnabledModel}
      editing={editing}
      setEditing={setEditing}
      error={error}
      handleSave={handleSave}
      handleSetDefault={handleSetDefault}
      handleRemove={handleRemove}
      onChanged={onChanged}
    />
  );
}

function ModelReview({ models }: { models: ModelConfig[] }) {
  return (
    <StepShell
      icon={<ShieldCheck size={18} />}
      eyebrow="Step 3 · Model"
      title="Here's your model"
      description="I'll leave it just as it is. You can change it later in Models settings."
    >
      <div className="space-y-2">
        {models.map((model) => (
          <div key={model.name} className="flex items-center gap-3 rounded-xl border border-border bg-surface-3 px-3 py-2.5">
            <span className="shrink-0 text-fg-subtle"><ProviderLogo name={model.provider} size={22} /></span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-fg">{model.name}</span>
                {model.is_default && <span className="text-[10px] font-medium text-emerald-700 dark:text-emerald-300">Default</span>}
              </div>
              <p className="truncate text-[11px] text-fg-faint">{model.provider} · {model.model_id}</p>
            </div>
          </div>
        ))}
      </div>
    </StepShell>
  );
}

function ModelSetup({ models, defaultProvider, hasEnabledModel, editing, setEditing, error, handleSave, handleSetDefault, handleRemove, onChanged }: {
  models: ModelConfig[];
  defaultProvider?: string;
  hasEnabledModel: boolean;
  editing: ModelConfig | null | "new";
  setEditing: (model: ModelConfig | null | "new") => void;
  error: string | null;
  handleSave: (name: string, data: Omit<ModelConfig, "name" | "enabled" | "created_at" | "updated_at">) => Promise<void>;
  handleSetDefault: (model: ModelConfig) => Promise<void>;
  handleRemove: (name: string) => Promise<void>;
  onChanged: () => void;
}) {
  return (
    <StepShell
      icon={<ShieldCheck size={18} />}
      eyebrow="Step 3 · Connect a model"
      title="Let's choose a model"
      description={defaultProvider
        ? `I found your ${defaultProvider} connection and will load its available models for you.`
        : "Choose a model to power our first conversation. You can switch or add more later."}
    >
      <div className="flex items-start gap-2 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2.5 text-xs text-fg">
        <Info size={14} className="mt-0.5 shrink-0 text-accent" />
        <div className="leading-relaxed">
          <p className="font-medium">No need to get everything perfect</p>
          <ul className="mt-1 space-y-0.5 text-fg-subtle">
            <li>• I&apos;ll use the provider key you just connected.</li>
            <li>• You can fine-tune model settings whenever you like.</li>
          </ul>
          <p className="mt-1 text-fg-subtle">You can add more models later from Settings → Models.</p>
        </div>
      </div>

      {!hasEnabledModel ? (
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-border bg-surface-3/40 px-4 py-10 text-sm text-fg-subtle transition-colors hover:border-accent/60 hover:bg-accent/5 hover:text-fg"
        >
          <Plus size={20} />
          <span className="font-medium">{models.length === 0 ? "Choose my first model" : "Add an enabled model"}</span>
          <span className="text-[11px] text-fg-faint">
            {models.length === 0 ? "I&apos;ll help you find one" : "Your saved models are disabled and can&apos;t start a chat."}
          </span>
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
                {!m.is_default && m.enabled !== false && (
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
          initialProvider={editing === "new" ? defaultProvider : undefined}
          autoLoadCatalog={editing === "new" && !!defaultProvider}
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
