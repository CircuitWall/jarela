import { Select } from "@/components/ui/Select";
import { GEMINI_STT_MODELS, GEMINI_TTS_MODELS, GEMINI_VOICES } from "@/lib/voice/constants";
import { useAppContext } from "@/contexts/AppContext";
import { computeFeatureReadiness } from "@/lib/ui/feature-readiness";
import type { IntegrationStatus, ModelConfig } from "@/api/types";
import type { AgentEditorForm } from "./useAgentEditorForm";

interface Props {
  form: AgentEditorForm;
  models: ModelConfig[];
  integrations: IntegrationStatus[];
  selectedModel: ModelConfig | undefined;
  onClose: () => void;
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
        <span className="text-xs text-fg-subtle">Enable voice (Gemini TTS + STT)</span>
      </label>
      <p className="text-[11px] text-fg-faint">
        When on, the chat input shows a microphone and assistant replies show a play button.
        Requires the Google integration api_key.
      </p>
      {!readiness.voiceReady && (
        <VoiceReadinessNotice
          hasGoogleIntegration={readiness.hasGoogleIntegration}
          onOpenModels={() => { onClose(); dispatch({ type: "SET_TAB", tab: "models" }); }}
          onOpenCredentials={() => {
            onClose();
            dispatch({ type: "SET_TAB", tab: "credentials" });
            dispatch({ type: "SET_SELECTION", tab: "credentials", itemId: "list" });
          }}
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
        <span className="text-xs text-fg-subtle mb-1 block">Transcription model</span>
        <Select value={form.voiceSttModel} onChange={(e) => form.setVoiceSttModel(e.target.value)} disabled={!form.voiceEnabled}>
          {GEMINI_STT_MODELS.map((m) => (<option key={m.id} value={m.id}>{m.id} — {m.label}</option>))}
        </Select>
      </label>
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
        Compatible setup: a Gemini model plus the existing Google AI integration. Without both, enabling voice would require extra setup.
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
