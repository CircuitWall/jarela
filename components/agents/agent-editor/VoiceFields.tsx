import { useCallback, useEffect, useState } from "react";
import { Select } from "@/components/ui/Select";
import { GEMINI_STT_MODELS, GEMINI_TTS_MODELS, GEMINI_VOICES } from "@/lib/voice/constants";
import { STT_ENGINES, sttEngineLabel, type SttEngine } from "@/lib/voice/stt/types";
import { useAppContext } from "@/contexts/AppContext";
import { computeFeatureReadiness } from "@/lib/ui/feature-readiness";
import { errorMessage } from "@/lib/utils/error";
import type { IntegrationStatus, ModelConfig } from "@/api/types";
import type { AgentEditorForm } from "./useAgentEditorForm";

interface Props {
  form: AgentEditorForm;
  models: ModelConfig[];
  integrations: IntegrationStatus[];
  selectedModel: ModelConfig | undefined;
  onClose: (after?: () => void) => void;
}

export function VoiceFields({ form, models, integrations, selectedModel, onClose }: Props) {
  const { dispatch } = useAppContext();
  const readiness = computeFeatureReadiness({
    models,
    integrations,
    selectedProvider: selectedModel?.provider,
    selectedModelId: selectedModel?.model_id,
  });
  return (
    <>
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          className="rounded border-border"
          checked={form.voiceEnabled}
          onChange={(e) => form.setVoiceEnabled(e.target.checked)}
        />
        <span className="text-xs text-fg-subtle">Enable voice</span>
      </label>
      <p className="text-[11px] text-fg-faint">
        When on, the chat input shows a microphone and assistant replies show a play button.
        Spoken replies always use Gemini TTS and need the Google integration api_key; input can
        use a local or browser engine instead.
      </p>
      {!readiness.voiceReady && (
        <VoiceReadinessNotice
          hasGoogleIntegration={readiness.hasGoogleIntegration}
          onOpenModels={() => onClose(() => dispatch({ type: "SET_TAB", tab: "models" }))}
          onOpenCredentials={() => onClose(() => {
            dispatch({ type: "SET_TAB", tab: "credentials" });
            dispatch({ type: "SET_SELECTION", tab: "credentials", itemId: "list" });
          })}
        />
      )}
      <VoicePickers form={form} />
    </>
  );
}

function VoicePickers({ form }: { form: AgentEditorForm }) {
  return (
    <>
      <label className="block">
        <span className="text-xs text-fg-subtle mb-1 block">TTS model</span>
        <Select value={form.voiceModel} onChange={(e) => form.setVoiceModel(e.target.value)} disabled={!form.voiceEnabled}>
          {GEMINI_TTS_MODELS.map((m) => (<option key={m.id} value={m.id}>{m.id} — {m.label}</option>))}
        </Select>
      </label>
      <label className="block">
        <span className="text-xs text-fg-subtle mb-1 block">Voice</span>
        <Select value={form.voiceName} onChange={(e) => form.setVoiceName(e.target.value)} disabled={!form.voiceEnabled}>
          {GEMINI_VOICES.map((v) => (<option key={v.id} value={v.id}>{v.label}</option>))}
        </Select>
      </label>
      <label className="block">
        <span className="text-xs text-fg-subtle mb-1 block">Speech recognition engine</span>
        <Select
          value={form.voiceSttEngine}
          onChange={(e) => form.setVoiceSttEngine(e.target.value as SttEngine)}
          disabled={!form.voiceEnabled}
        >
          {STT_ENGINES.map((engine) => (
            <option key={engine} value={engine}>{sttEngineLabel(engine)}</option>
          ))}
        </Select>
      </label>
      <p className="text-[11px] text-fg-faint">
        Browser: free and instant, but Chromium/Safari only and weaker on technical terms.
        Whisper: runs locally on this machine after a one-time ~45 MB model download.
        Gemini: sends audio to Google and needs the Google integration.
      </p>
      {form.voiceEnabled && form.voiceSttEngine === "whisper" && <WhisperModelPanel />}
      {form.voiceSttEngine === "gemini" && (
        <label className="block">
          <span className="text-xs text-fg-subtle mb-1 block">Transcription model</span>
          <Select value={form.voiceSttModel} onChange={(e) => form.setVoiceSttModel(e.target.value)} disabled={!form.voiceEnabled}>
            {GEMINI_STT_MODELS.map((m) => (<option key={m.id} value={m.id}>{m.id} — {m.label}</option>))}
          </Select>
        </label>
      )}
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          className="rounded border-border"
          checked={form.voiceAutoSpeak}
          onChange={(e) => form.setVoiceAutoSpeak(e.target.checked)}
          disabled={!form.voiceEnabled}
        />
        <span className="text-xs text-fg-subtle">Auto-speak reply when I send a voice message</span>
      </label>
    </>
  );
}

interface WhisperStatus {
  model: { state: "ready" | "downloading" | "failed" | "missing"; totalBytes: number; error?: string };
  runtime_installed: boolean;
  runtime_package: string;
  download_disabled: boolean;
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** One-time local model install for the Whisper engine (ADR-0123). */
function WhisperModelPanel() {
  const [status, setStatus] = useState<WhisperStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/voice/whisper", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json() as WhisperStatus);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const downloading = status?.model.state === "downloading";
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void load(), 3_000);
    return () => clearInterval(timer);
  }, [downloading, load]);

  async function startDownload() {
    setStarting(true);
    try {
      await fetch("/api/v1/voice/whisper", { method: "POST" });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  }

  const size = status ? formatMegabytes(status.model.totalBytes) : "";
  const runtimeMissing = !!status && !status.runtime_installed;
  return (
    <div className="rounded-lg border border-border/50 bg-surface-muted/40 px-3 py-2 text-[11px] leading-snug">
      {error && <p className="text-rose-500">{error}</p>}
      {!error && !status && <p className="text-fg-faint">Checking the local Whisper model…</p>}
      {!error && status?.model.state === "ready" && (
        <p className="text-fg-subtle">Whisper model installed ({size}). Audio never leaves this machine.</p>
      )}
      {!error && downloading && (
        <p className="text-fg-subtle">Downloading the Whisper model ({size})… this continues in the background.</p>
      )}
      {!error && status && (status.model.state === "missing" || status.model.state === "failed") && (
        <>
          <p className="text-fg-subtle">
            {status.model.state === "failed" ? "Whisper model download failed" : "Whisper model is not installed"}
            {status.model.error ? `: ${status.model.error}` : "."}
          </p>
          <button
            type="button"
            onClick={startDownload}
            disabled={starting || status.download_disabled || runtimeMissing}
            className="mt-2 rounded-md border border-border/60 bg-surface px-2 py-1 text-[11px] font-medium text-fg-subtle disabled:opacity-50"
          >
            {starting ? "Starting…" : `Download ${size}`}
          </button>
        </>
      )}
      {!error && runtimeMissing && (
        <p className="mt-1 text-amber-700 dark:text-amber-300">
          Whisper also needs the &quot;{status.runtime_package}&quot; runtime, which is not installed yet:
          Settings → Tools → Packages.
        </p>
      )}
    </div>
  );
}

function VoiceReadinessNotice({
  hasGoogleIntegration,
  onOpenModels,
  onOpenCredentials,
}: {
  hasGoogleIntegration: boolean;
  onOpenModels: () => void;
  onOpenCredentials: () => void;
}) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200 leading-snug">
      <p>Voice is not fully ready at the system level yet.</p>
      <p className="mt-1 text-amber-900/90 dark:text-amber-100/90">
        Spoken replies need a Gemini model plus the existing Google AI integration. Without both, enabling voice would require extra setup.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onOpenModels}
          className="rounded-md border border-amber-600/30 bg-white/50 px-2 py-1 text-[11px] font-medium text-amber-900 dark:bg-black/10 dark:text-amber-100"
        >
          Open Models
        </button>
        {!hasGoogleIntegration && (
          <button
            type="button"
            onClick={onOpenCredentials}
            className="rounded-md border border-amber-600/30 bg-white/50 px-2 py-1 text-[11px] font-medium text-amber-900 dark:bg-black/10 dark:text-amber-100"
          >
            Open Credentials
          </button>
        )}
      </div>
    </div>
  );
}
