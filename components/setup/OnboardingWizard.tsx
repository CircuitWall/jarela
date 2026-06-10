"use client";

import { ArrowLeft, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type { AgentConfig, IntegrationStatus, ModelConfig, UserProfile } from "@/api/types";
import { useAppContext } from "@/contexts/AppContext";
import { getAppName } from "@/lib/env/app-config";
import { Logo } from "@/components/ui/Logo";
import {
  AGENT_STYLES,
  PROVIDER_INFO,
  supportedProvider,
  type AgentStyle,
  type Provider,
  type TestResult,
} from "./wizard/constants";
import { StepAgent } from "./wizard/StepAgent";
import { StepModel } from "./wizard/StepModel";
import { StepProfile } from "./wizard/StepProfile";
import { StepReview } from "./wizard/StepReview";
import { WizardStepper, type StepInfo } from "./wizard/WizardStepper";

interface Props {
  context: "setup" | "profile";
}

const STEPS: StepInfo[] = [
  { id: "profile", title: "About you", short: "Profile" },
  { id: "model", title: "Model", short: "Model" },
  { id: "agent", title: "Agent", short: "Agent" },
  { id: "review", title: "Review", short: "Review" },
];

function syntheticGoogleIntegration(): IntegrationStatus {
  return { name: "google", configured: true, values: {}, updated_at: null };
}

export function OnboardingWizard({ context }: Props) {
  const { state, dispatch } = useAppContext();
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);

  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [preset, setPreset] = useState<NonNullable<UserProfile["preset"]>>("home");
  const [provider, setProvider] = useState<Provider>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState(PROVIDER_INFO.anthropic.defaultModel);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [test, setTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [reuseGoogleKey, setReuseGoogleKey] = useState(true);
  const [useAsChatDefault, setUseAsChatDefault] = useState(true);
  const [useAsEmbeddingDefault, setUseAsEmbeddingDefault] = useState(true);
  const [useAsVoicePath, setUseAsVoicePath] = useState(true);
  const [agentName, setAgentName] = useState("My Assistant");
  const [agentStyle, setAgentStyle] = useState<AgentStyle>("assistant");
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [profileData, modelRows, agentRows, integrationRows] = await Promise.all([
          api.profile.get().catch(() => null),
          api.models.list().catch(() => []),
          api.agents.list().catch(() => []),
          api.integrations.list().then((res) => res.statuses).catch(() => []),
        ]);
        if (cancelled) return;

        const defaultModel = modelRows.find((row) => row.is_default) ?? modelRows[0] ?? null;
        const defaultAgent = agentRows.find((row) => row.is_default) ?? agentRows[0] ?? null;

        setModels(modelRows);
        setAgents(agentRows);
        setIntegrations(integrationRows);

        setName(profileData?.name ?? "");
        setAbout(profileData?.about ?? "");
        setPreset((profileData?.preset as NonNullable<UserProfile["preset"]> | null) ?? "home");

        const resolvedProvider = supportedProvider(defaultModel?.provider);
        setProvider(resolvedProvider);
        setApiKey(typeof defaultModel?.params.api_key === "string" ? defaultModel.params.api_key : "");
        setModelId(defaultModel?.model_id ?? PROVIDER_INFO[resolvedProvider].defaultModel);

        setAgentName(defaultAgent?.name ?? `${profileData?.name?.trim() || "My"} Assistant`);
        setVoiceEnabled(defaultAgent?.voice_enabled ?? false);
        setUseAsChatDefault(defaultModel?.is_default ?? true);
        setUseAsEmbeddingDefault(true);
        setUseAsVoicePath(defaultAgent?.voice_enabled ?? true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  const activeModel = models.find((row) => row.is_default) ?? models[0] ?? null;
  const activeAgent = agents.find((row) => row.is_default) ?? agents[0] ?? null;
  const effectiveIntegrations = useMemo(() => {
    if (provider === "gemini" && reuseGoogleKey && apiKey.trim()) {
      const hasGoogle = integrations.some((s) => s.name === "google" && s.configured);
      return hasGoogle ? integrations : [...integrations, syntheticGoogleIntegration()];
    }
    return integrations;
  }, [apiKey, integrations, provider, reuseGoogleKey]);
  const modelReady = !!modelId.trim() && (!!test?.ok || (activeModel != null && apiKey.trim().length > 0));
  const canSave = name.trim().length > 0 && agentName.trim().length > 0 && modelReady;

  function chooseProvider(next: Provider) {
    setProvider(next);
    setModelId(PROVIDER_INFO[next].defaultModel);
    setAvailableModels([]);
    setTest(null);
    setSaveError(null);
    if (next !== "gemini") setVoiceEnabled(false);
  }

  async function runTest() {
    if (!apiKey.trim()) return;
    setTesting(true);
    setTest(null);
    setSaveError(null);
    try {
      const res = await fetch("/api/v1/setup/test-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim() }),
      });
      const data = (await res.json()) as TestResult;
      setTest(data);
      setAvailableModels(data.models ?? []);
      if (data.ok && data.models && data.models.length > 0 && !data.models.includes(modelId)) {
        setModelId(data.models[0]);
      }
    } catch (err) {
      setTest({ ok: false, error: `network error: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.profile.update({ name: name.trim(), about: about.trim(), preset });

      const modelName = activeModel?.name ?? `${provider}-default`;
      const modelPayload = {
        provider,
        model_id: modelId.trim(),
        params: { ...(activeModel?.params ?? {}), api_key: apiKey.trim() },
        is_default: useAsChatDefault || !activeModel,
      };
      const savedModel = activeModel
        ? await api.models.update(modelName, modelPayload)
        : await api.models.create(modelName, modelPayload);

      if (useAsEmbeddingDefault) {
        await api.documents.setSettings({ embedding_model_config: savedModel.name });
      }
      if (provider === "gemini" && reuseGoogleKey && apiKey.trim()) {
        await api.integrations.save("google", { api_key: apiKey.trim() });
      }

      const style = AGENT_STYLES[agentStyle];
      const agentPayload = {
        name: agentName.trim(),
        identity: style.identity,
        instructions: style.instructions,
        model_config_name: savedModel.name,
        is_default: true,
        voice_enabled: provider === "gemini" && reuseGoogleKey && useAsVoicePath && voiceEnabled,
        voice_model: "gemini-2.5-flash-preview-tts",
        voice_name: "Kore",
        voice_stt_model: "gemini-2.5-flash",
        voice_auto_speak: true,
      };
      const savedAgent = activeAgent
        ? await api.agents.update(activeAgent.id, agentPayload)
        : await api.agents.create(agentPayload);

      if (context === "setup") {
        window.location.href = "/";
        return;
      }
      dispatch({ type: "SET_AGENT", agentId: savedAgent.id });
      dispatch({ type: "SET_TAB", tab: "chat" });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const fullScreen = context === "setup";

  const canAdvance = (() => {
    if (step === 0) return name.trim().length > 0;
    if (step === 1) return modelReady;
    if (step === 2) return agentName.trim().length > 0;
    return canSave;
  })();
  const isLast = step === STEPS.length - 1;

  if (loading) {
    return (
      <div className={`flex items-center justify-center ${fullScreen ? "min-h-screen" : "h-full"} bg-surface text-fg`}>
        <div className="inline-flex items-center gap-2 text-sm text-fg-faint">
          <Loader2 size={16} className="animate-spin" /> Loading setup
        </div>
      </div>
    );
  }

  return (
    <main className={`flex ${fullScreen ? "min-h-screen" : "h-full"} flex-col bg-surface text-fg`}>
      <header className="sticky top-0 z-20 border-b border-border bg-surface/85 px-4 py-3 backdrop-blur-xl sm:px-8">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
          <div className="flex items-center gap-3">
            {fullScreen && <Logo className="h-7 w-auto" />}
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-fg-faint">
                {fullScreen ? "First launch setup" : state.experienceMode === "essential" ? "Guided setup" : "Profile"}
              </div>
              <div className="truncate text-sm font-medium">
                {fullScreen ? `Set up ${getAppName()}` : "Set up your assistant"}
              </div>
            </div>
            <div className="text-[11px] text-fg-faint">
              Step {step + 1} of {STEPS.length}
            </div>
          </div>
          <WizardStepper steps={STEPS} current={step} onJump={(i) => setStep(i)} />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-8 sm:px-6 sm:py-10">
        {step === 0 && (
          <StepProfile
            name={name}
            onNameChange={setName}
            about={about}
            onAboutChange={setAbout}
            preset={preset}
            onPresetChange={setPreset}
          />
        )}
        {step === 1 && (
          <StepModel
            provider={provider}
            onProviderChange={chooseProvider}
            apiKey={apiKey}
            onApiKeyChange={(v) => { setApiKey(v); setTest(null); }}
            modelId={modelId}
            onModelIdChange={setModelId}
            availableModels={availableModels}
            test={test}
            testing={testing}
            onRunTest={runTest}
            reuseGoogleKey={reuseGoogleKey}
            onReuseGoogleKeyChange={setReuseGoogleKey}
            useAsChatDefault={useAsChatDefault}
            onUseAsChatDefaultChange={setUseAsChatDefault}
            useAsEmbeddingDefault={useAsEmbeddingDefault}
            onUseAsEmbeddingDefaultChange={setUseAsEmbeddingDefault}
            useAsVoicePath={useAsVoicePath}
            onUseAsVoicePathChange={setUseAsVoicePath}
            models={models}
            integrations={effectiveIntegrations}
          />
        )}
        {step === 2 && (
          <StepAgent
            agentName={agentName}
            onAgentNameChange={setAgentName}
            agentStyle={agentStyle}
            onAgentStyleChange={setAgentStyle}
            voiceEnabled={voiceEnabled}
            onVoiceEnabledChange={setVoiceEnabled}
            provider={provider}
            reuseGoogleKey={reuseGoogleKey}
          />
        )}
        {step === 3 && (
          <StepReview
            name={name}
            about={about}
            preset={preset}
            provider={provider}
            modelId={modelId}
            reuseGoogleKey={reuseGoogleKey}
            useAsChatDefault={useAsChatDefault}
            useAsEmbeddingDefault={useAsEmbeddingDefault}
            useAsVoicePath={useAsVoicePath}
            agentName={agentName}
            agentStyle={agentStyle}
            voiceEnabled={voiceEnabled}
            models={models}
            integrations={effectiveIntegrations}
          />
        )}
      </div>

      <footer className="sticky bottom-0 z-20 border-t border-border bg-surface/85 px-4 py-3 backdrop-blur-xl sm:px-8">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-3">
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || saving}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border px-4 py-2.5 text-sm hover:border-fg-faint disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowLeft size={14} /> Back
          </button>

          {fullScreen && (
            <div className="flex flex-1 items-center justify-center gap-2 text-[11px] text-fg-faint">
              {(["essential", "full"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => dispatch({ type: "SET_EXPERIENCE_MODE", mode })}
                  aria-pressed={state.experienceMode === mode}
                  className={`rounded-full border px-2.5 py-1 transition-colors ${
                    state.experienceMode === mode
                      ? "border-accent/60 bg-accent/15 text-fg"
                      : "border-border bg-surface-2 hover:border-fg-faint"
                  }`}
                >
                  {mode === "essential" ? "Guided" : "Full controls"}
                </button>
              ))}
            </div>
          )}
          {!fullScreen && <div className="flex-1" />}

          {saveError && isLast && (
            <span className="hidden text-xs text-rose-600 dark:text-rose-300 sm:inline">{saveError}</span>
          )}

          {isLast ? (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !canSave}
              className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {context === "setup" ? "Finish setup" : "Save and open chat"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
              disabled={!canAdvance}
              className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next <ArrowRight size={14} />
            </button>
          )}
        </div>
        {saveError && isLast && (
          <p className="mx-auto mt-2 max-w-2xl text-center text-xs text-rose-600 dark:text-rose-300 sm:hidden">{saveError}</p>
        )}
      </footer>
    </main>
  );
}
