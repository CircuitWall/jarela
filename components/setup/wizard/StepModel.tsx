"use client";
import { CheckCircle2, Code2, Database, ExternalLink, Image as ImageIcon, Loader2, Mic, ShieldCheck, XCircle } from "lucide-react";
import type { IntegrationStatus, ModelConfig } from "@/api/types";
import { ModelFeatureGuide } from "@/components/models/ModelFeatureGuide";
import { PROVIDER_INFO, PROVIDER_SIGNALS, signalTone, type Provider, type TestResult } from "./constants";
import { StepShell } from "./StepShell";

interface StepModelProps {
  provider: Provider;
  onProviderChange: (p: Provider) => void;
  apiKey: string;
  onApiKeyChange: (v: string) => void;
  modelId: string;
  onModelIdChange: (v: string) => void;
  availableModels: string[];
  test: TestResult | null;
  testing: boolean;
  onRunTest: () => void;
  reuseGoogleKey: boolean;
  onReuseGoogleKeyChange: (v: boolean) => void;
  useAsChatDefault: boolean;
  onUseAsChatDefaultChange: (v: boolean) => void;
  useAsEmbeddingDefault: boolean;
  onUseAsEmbeddingDefaultChange: (v: boolean) => void;
  useAsVoicePath: boolean;
  onUseAsVoicePathChange: (v: boolean) => void;
  models: ModelConfig[];
  integrations: IntegrationStatus[];
}

export function StepModel(props: StepModelProps) {
  const {
    provider, onProviderChange, apiKey, onApiKeyChange,
    modelId, onModelIdChange, availableModels,
    test, testing, onRunTest,
    reuseGoogleKey, onReuseGoogleKeyChange,
    useAsChatDefault, onUseAsChatDefaultChange,
    useAsEmbeddingDefault, onUseAsEmbeddingDefaultChange,
    useAsVoicePath, onUseAsVoicePathChange,
    models, integrations,
  } = props;
  const providerInfo = PROVIDER_INFO[provider];
  const providerSignals = PROVIDER_SIGNALS[provider];

  return (
    <StepShell
      icon={<ShieldCheck size={18} />}
      eyebrow="Step 2 · Model"
      title="Connect a provider and pick a model"
      description="Choose where the assistant gets its intelligence. The feature signals below update as you choose."
    >
      <div>
        <span className="mb-2 block text-xs font-medium text-fg-subtle">Provider</span>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(Object.keys(PROVIDER_INFO) as Provider[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onProviderChange(option)}
              className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                provider === option
                  ? "border-accent/60 bg-accent/15 shadow-sm"
                  : "border-border bg-surface-3 hover:border-fg-faint"
              }`}
            >
              <div className="text-sm font-medium">{PROVIDER_INFO[option].label}</div>
              <div className="mt-1 text-[11px] leading-snug text-fg-faint">{PROVIDER_INFO[option].hint}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-surface-3/70 px-3 py-3 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Capability preview</p>
          <p className="text-[11px] text-fg-faint">{providerInfo.label}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <CapabilityTile level={providerSignals.image} icon={<ImageIcon size={12} />} label="Image" />
          <CapabilityTile level={providerSignals.voice} icon={<Mic size={12} />} label="Voice" />
          <CapabilityTile level={providerSignals.embeddings} icon={<Database size={12} />} label="Embeddings" />
          <CapabilityTile level={providerSignals.coding} icon={<Code2 size={12} />} label="Coding" />
        </div>
        <p className="text-[11px] leading-snug text-fg-subtle">
          <span className="font-medium text-fg">Recommendation:</span> {providerSignals.recommendation}
        </p>
      </div>

      <div className="grid grid-cols-1 items-end gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
        <label className="block">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-fg-subtle">API key</span>
            <a
              href={providerInfo.signupUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-[11px] text-accent hover:text-accent-hover"
            >
              Get key <ExternalLink size={11} />
            </a>
          </div>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder={providerInfo.placeholder}
            className="w-full rounded-xl border border-border bg-surface-3 px-3 py-2.5 font-mono text-sm focus:border-accent focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          onClick={onRunTest}
          disabled={testing || !apiKey.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm hover:border-fg-faint disabled:opacity-50"
        >
          {testing ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
          {testing ? "Testing" : "Test connection"}
        </button>
      </div>

      {provider === "gemini" && (
        <label className="flex items-start gap-2 rounded-xl border border-border bg-surface-3 px-3 py-2.5">
          <input
            type="checkbox"
            className="mt-0.5 rounded border-border"
            checked={reuseGoogleKey}
            onChange={(e) => onReuseGoogleKeyChange(e.target.checked)}
          />
          <span className="text-[11px] leading-snug text-fg-subtle">
            Reuse this Gemini key for Google AI features like voice and image tools, so you don&apos;t have to configure a second credential.
          </span>
        </label>
      )}

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-fg-subtle">Model</span>
        {availableModels.length > 0 ? (
          <select
            value={modelId}
            onChange={(e) => onModelIdChange(e.target.value)}
            className="w-full rounded-xl border border-border bg-surface-3 px-3 py-2.5 text-sm"
          >
            {availableModels.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        ) : (
          <input
            value={modelId}
            onChange={(e) => onModelIdChange(e.target.value)}
            className="w-full rounded-xl border border-border bg-surface-3 px-3 py-2.5 font-mono text-sm"
          />
        )}
      </label>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <DefaultsCheckbox label="Default chat model" checked={useAsChatDefault} onChange={onUseAsChatDefaultChange} />
        <DefaultsCheckbox label="Default embeddings model" checked={useAsEmbeddingDefault} onChange={onUseAsEmbeddingDefaultChange} />
        <DefaultsCheckbox label="Voice-capable path" checked={useAsVoicePath} onChange={onUseAsVoicePathChange} disabled={provider !== "gemini"} />
      </div>

      {test && (
        <div className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm ${
          test.ok
            ? "border-emerald-700/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            : "border-rose-700/40 bg-rose-500/10 text-rose-700 dark:text-rose-300"
        }`}>
          {test.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}
          <span>{test.ok ? `Connection validated. ${test.models?.length ?? 0} models available.` : test.error}</span>
        </div>
      )}

      <details className="rounded-xl border border-border bg-surface-2/60 px-3 py-2 text-xs text-fg-subtle">
        <summary className="cursor-pointer font-medium text-fg">Feature signals for this exact model</summary>
        <div className="mt-3">
          <ModelFeatureGuide
            provider={provider}
            modelId={modelId}
            models={models}
            integrations={integrations}
            title=""
            description="These icons update as you choose a provider and model, so you can see what ships with this setup before saving it."
          />
        </div>
      </details>
    </StepShell>
  );
}

function CapabilityTile({ level, icon, label }: { level: "strong" | "partial" | "limited"; icon: React.ReactNode; label: string }) {
  return (
    <div className={`rounded-lg border px-2 py-1.5 text-[11px] ${signalTone(level)}`}>
      <div className="inline-flex items-center gap-1">{icon} {label}</div>
    </div>
  );
}

function DefaultsCheckbox({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 ${disabled ? "border-border/60 bg-surface-2 opacity-70" : "border-border bg-surface-3"}`}>
      <input
        type="checkbox"
        className="mt-0.5 rounded border-border"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      <span className="text-[11px] leading-snug text-fg-subtle">{label}</span>
    </label>
  );
}
