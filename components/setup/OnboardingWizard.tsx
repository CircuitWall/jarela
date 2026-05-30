"use client";

import { Bot, Brain, Briefcase, CheckCircle2, Code2, Database, ExternalLink, Image, Loader2, Mic, ShieldCheck, Sparkles, UserRound, Wand2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type { AgentConfig, IntegrationStatus, ModelConfig, UserProfile } from "@/api/types";
import { useAppContext } from "@/contexts/AppContext";
import { getAppName } from "@/lib/env/app-config";
import { ModelFeatureGuide } from "@/components/models/ModelFeatureGuide";

type Provider = "anthropic" | "openai" | "gemini" | "deepseek";

const PROVIDER_INFO: Record<
  Provider,
  { label: string; signupUrl: string; placeholder: string; defaultModel: string; hint: string }
> = {
  anthropic: {
    label: "Anthropic (Claude)",
    signupUrl: "https://console.anthropic.com/settings/keys",
    placeholder: "sk-ant-…",
    defaultModel: "claude-opus-4-7",
    hint: "Strong writing and reasoning. Good default if you want a focused assistant.",
  },
  openai: {
    label: "OpenAI (GPT)",
    signupUrl: "https://platform.openai.com/api-keys",
    placeholder: "sk-…",
    defaultModel: "gpt-4o",
    hint: "Balanced general-purpose setup with broad capability coverage.",
  },
  gemini: {
    label: "Google (Gemini)",
    signupUrl: "https://aistudio.google.com/apikey",
    placeholder: "AIza…",
    defaultModel: "gemini-2.5-pro",
    hint: "Best fit if you want voice and Google-powered multimodal features with one key.",
  },
  deepseek: {
    label: "DeepSeek",
    signupUrl: "https://platform.deepseek.com/api_keys",
    placeholder: "sk-…",
    defaultModel: "deepseek-chat",
    hint: "Lean and capable text setup when you want a simpler provider choice.",
  },
};

const PROVIDER_SIGNALS: Record<Provider, {
  image: "strong" | "partial" | "limited";
  voice: "strong" | "partial" | "limited";
  embeddings: "strong" | "partial" | "limited";
  coding: "strong" | "partial" | "limited";
  recommendation: string;
}> = {
  anthropic: {
    image: "strong",
    voice: "limited",
    embeddings: "limited",
    coding: "strong",
    recommendation: "Excellent coding copilot style responses; pair with a separate embeddings path if Documents recall is critical.",
  },
  openai: {
    image: "strong",
    voice: "partial",
    embeddings: "strong",
    coding: "strong",
    recommendation: "Best all-round baseline when you want one provider to cover coding plus embeddings-driven workflows.",
  },
  gemini: {
    image: "strong",
    voice: "strong",
    embeddings: "strong",
    coding: "strong",
    recommendation: "Strong single-provider setup for multimodal + voice without splitting credentials.",
  },
  deepseek: {
    image: "limited",
    voice: "limited",
    embeddings: "limited",
    coding: "strong",
    recommendation: "Great text/coding value path; pair with another provider if you need richer multimodal or embeddings.",
  },
};

function signalTone(level: "strong" | "partial" | "limited"): string {
  if (level === "strong") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (level === "partial") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-border bg-surface-3 text-fg-faint";
}

const PROFILE_PRESETS: Array<{ value: NonNullable<UserProfile["preset"]>; label: string; hint: string }> = [
  { value: "home", label: "Home", hint: "Personal AI, mail, calendar, and everyday tasks" },
  { value: "work", label: "Work", hint: "Project coordination, docs, issues, and team workflows" },
  { value: "dev", label: "Developer", hint: "Coding, debugging, tools, and infrastructure-heavy usage" },
  { value: "custom", label: "Everything", hint: "Show the full surface without category filtering" },
];

const AGENT_STYLES = {
  assistant: {
    label: "General Assistant",
    hint: "Balanced help across chat, research, and daily tasks",
    icon: Sparkles,
    identity: "You are a practical personal assistant. Be clear, concise, and helpful. Focus on getting the user unstuck quickly.",
    instructions: "Prefer straightforward answers, ask only necessary follow-up questions, and keep technical detail proportional to the user's request.",
  },
  builder: {
    label: "Builder",
    hint: "Best when you mostly use the app for coding and implementation",
    icon: Wand2,
    identity: "You are a pragmatic software builder who turns vague requests into concrete implementation steps.",
    instructions: "Bias toward implementation, explain tradeoffs briefly, and keep momentum high on technical tasks.",
  },
  researcher: {
    label: "Research Partner",
    hint: "Good for synthesis, comparisons, and exploration",
    icon: Brain,
    identity: "You are a research partner who organizes information clearly and highlights the strongest options.",
    instructions: "Structure findings cleanly, surface tradeoffs, and focus on decision support instead of raw data dumps.",
  },
  operator: {
    label: "Work Coordinator",
    hint: "Better for work streams, follow-ups, and operational tasks",
    icon: Briefcase,
    identity: "You are an operational coordinator who keeps work moving and communicates with calm clarity.",
    instructions: "Prioritize action items, summarize status clearly, and help the user track what matters next.",
  },
} as const;

type AgentStyle = keyof typeof AGENT_STYLES;

interface TestResult {
  ok: boolean;
  models?: string[];
  error?: string;
}

interface Props {
  context: "setup" | "profile";
}

function supportedProvider(value: string | null | undefined): Provider {
  if (value === "anthropic" || value === "openai" || value === "gemini" || value === "deepseek") return value;
  return "anthropic";
}

function syntheticGoogleIntegration(): IntegrationStatus {
  return {
    name: "google",
    configured: true,
    values: {},
    updated_at: null,
  };
}

export function OnboardingWizard({ context }: Props) {
  const { state, dispatch } = useAppContext();
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);

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

        setProfile(profileData);
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
    return () => {
      cancelled = true;
    };
  }, []);

  const activeModel = models.find((row) => row.is_default) ?? models[0] ?? null;
  const activeAgent = agents.find((row) => row.is_default) ?? agents[0] ?? null;
  const providerInfo = PROVIDER_INFO[provider];
  const providerSignals = PROVIDER_SIGNALS[provider];
  const effectiveIntegrations = useMemo(() => {
    if (provider === "gemini" && reuseGoogleKey && apiKey.trim()) {
      const hasGoogle = integrations.some((status) => status.name === "google" && status.configured);
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
      const updatedProfile = await api.profile.update({ name: name.trim(), about: about.trim(), preset });
      setProfile(updatedProfile);

      const modelName = activeModel?.name ?? `${provider}-default`;
      const modelPayload = {
        provider,
        model_id: modelId.trim(),
        params: {
          ...(activeModel?.params ?? {}),
          api_key: apiKey.trim(),
        },
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

  if (loading) {
    return (
      <div className={`flex items-center justify-center ${fullScreen ? "min-h-screen" : "h-full"}`}>
        <div className="inline-flex items-center gap-2 text-sm text-fg-faint">
          <Loader2 size={16} className="animate-spin" /> Loading setup
        </div>
      </div>
    );
  }

  return (
    <main className={`${fullScreen ? "min-h-screen bg-surface" : "h-full bg-surface"} text-fg`}>
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6 flex items-start gap-4">
          {fullScreen && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/logo-mark-transparent.png" alt="" className="mt-1 h-11 w-auto" />
          )}
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-fg-faint">
              {fullScreen ? "First launch setup" : state.experienceMode === "normal" ? "Guided setup" : "Profile"}
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              {fullScreen ? `Set up ${getAppName()} once` : "Set up your assistant"}
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-fg-subtle leading-relaxed">
              Configure your profile, choose a model, and create a first agent from one screen. As you change the model, the feature icons below light up to show what the provider and model actually ship.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.9fr)] gap-5">
          <div className="space-y-5">
            <section className="rounded-2xl border border-border bg-surface-2 p-4 sm:p-5 space-y-4 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-accent/15 text-accent">
                  <UserRound size={16} />
                </span>
                <div>
                  <h2 className="text-sm font-semibold">1. Your profile</h2>
                  <p className="text-[11px] text-fg-faint">This shapes the app and tells the assistant who it is helping.</p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs text-fg-subtle mb-1 block">Your name</span>
                  <input
                    className="w-full rounded-xl border border-border bg-surface-3 px-3 py-2 text-sm"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                  />
                </label>
                <div className="space-y-1.5">
                  <span className="text-xs text-fg-subtle block">Experience mode</span>
                  <div className="grid grid-cols-2 gap-2">
                    {(["normal", "advanced"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => dispatch({ type: "SET_EXPERIENCE_MODE", mode })}
                        className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                          state.experienceMode === mode
                            ? "border-accent/60 bg-accent/15 shadow-sm"
                            : "border-border bg-surface-3"
                        }`}
                      >
                        <div className="text-xs font-medium capitalize">{mode}</div>
                        <div className="mt-0.5 text-[10px] text-fg-faint">{mode === "normal" ? "Simpler day-to-day setup" : "Full controls and tuning"}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <label className="block">
                <span className="text-xs text-fg-subtle mb-1 block">About you</span>
                <textarea
                  className="h-24 w-full resize-none rounded-xl border border-border bg-surface-3 px-3 py-2 text-sm"
                  value={about}
                  onChange={(e) => setAbout(e.target.value)}
                  placeholder="What should your assistant know about how you work and what you care about?"
                />
              </label>

              <div>
                <span className="text-xs text-fg-subtle mb-2 block">What kind of setup do you want?</span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {PROFILE_PRESETS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setPreset(option.value)}
                      className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                        preset === option.value
                          ? "border-accent/60 bg-accent/15 shadow-sm"
                          : "border-border bg-surface-3"
                      }`}
                    >
                      <div className="text-xs font-medium">{option.label}</div>
                      <div className="mt-1 text-[10px] text-fg-faint leading-snug">{option.hint}</div>
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-surface-2 p-4 sm:p-5 space-y-4 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-accent/15 text-accent">
                  <ShieldCheck size={16} />
                </span>
                <div>
                  <h2 className="text-sm font-semibold">2. Pick your model</h2>
                  <p className="text-[11px] text-fg-faint">Choose a provider, test the key, and see which features this model unlocks.</p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {(Object.keys(PROVIDER_INFO) as Provider[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => chooseProvider(option)}
                    className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                      provider === option
                        ? "border-accent/60 bg-accent/15 shadow-sm"
                        : "border-border bg-surface-3"
                    }`}
                  >
                    <div className="text-sm font-medium">{PROVIDER_INFO[option].label}</div>
                    <div className="mt-1 text-[11px] text-fg-faint leading-snug">{PROVIDER_INFO[option].hint}</div>
                  </button>
                ))}
              </div>

              <div className="rounded-xl border border-border bg-surface-3/70 px-3 py-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Provider capability preview</p>
                  <p className="text-[11px] text-fg-faint">{PROVIDER_INFO[provider].label}</p>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className={`rounded-lg border px-2 py-1.5 text-[11px] ${signalTone(providerSignals.image)}`}>
                    <div className="inline-flex items-center gap-1"><Image size={12} /> Image</div>
                  </div>
                  <div className={`rounded-lg border px-2 py-1.5 text-[11px] ${signalTone(providerSignals.voice)}`}>
                    <div className="inline-flex items-center gap-1"><Mic size={12} /> Voice</div>
                  </div>
                  <div className={`rounded-lg border px-2 py-1.5 text-[11px] ${signalTone(providerSignals.embeddings)}`}>
                    <div className="inline-flex items-center gap-1"><Database size={12} /> Embeddings</div>
                  </div>
                  <div className={`rounded-lg border px-2 py-1.5 text-[11px] ${signalTone(providerSignals.coding)}`}>
                    <div className="inline-flex items-center gap-1"><Code2 size={12} /> Coding</div>
                  </div>
                </div>
                <p className="text-[11px] leading-snug text-fg-subtle">
                  <span className="font-medium text-fg">Recommendation:</span> {providerSignals.recommendation}
                </p>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
                <label className="block">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-xs text-fg-subtle">API key</span>
                    <a
                      href={providerInfo.signupUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-[11px] text-accent hover:text-accent-hover inline-flex items-center gap-1"
                    >
                      Get key <ExternalLink size={11} />
                    </a>
                  </div>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setTest(null);
                    }}
                    placeholder={providerInfo.placeholder}
                    className="w-full rounded-xl border border-border bg-surface-3 px-3 py-2 text-sm font-mono"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <button
                  type="button"
                  onClick={runTest}
                  disabled={testing || !apiKey.trim()}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-border px-4 py-2 text-sm hover:border-fg-faint disabled:opacity-50"
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
                    onChange={(e) => setReuseGoogleKey(e.target.checked)}
                  />
                  <span className="text-[11px] leading-snug text-fg-subtle">
                    Reuse this same Gemini key for Google AI features like voice and image tools. This avoids asking you to configure a second credential for the same provider.
                  </span>
                </label>
              )}

              <label className="block">
                <span className="text-xs text-fg-subtle mb-1 block">Model</span>
                {availableModels.length > 0 ? (
                  <select
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    className="w-full rounded-xl border border-border bg-surface-3 px-3 py-2 text-sm"
                  >
                    {availableModels.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    className="w-full rounded-xl border border-border bg-surface-3 px-3 py-2 text-sm font-mono"
                  />
                )}
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <label className="flex items-start gap-2 rounded-xl border border-border bg-surface-3 px-3 py-2.5">
                  <input
                    type="checkbox"
                    className="mt-0.5 rounded border-border"
                    checked={useAsChatDefault}
                    onChange={(e) => setUseAsChatDefault(e.target.checked)}
                  />
                  <span className="text-[11px] leading-snug text-fg-subtle">
                    Default chat model
                  </span>
                </label>
                <label className="flex items-start gap-2 rounded-xl border border-border bg-surface-3 px-3 py-2.5">
                  <input
                    type="checkbox"
                    className="mt-0.5 rounded border-border"
                    checked={useAsEmbeddingDefault}
                    onChange={(e) => setUseAsEmbeddingDefault(e.target.checked)}
                  />
                  <span className="text-[11px] leading-snug text-fg-subtle">
                    Default embeddings model
                  </span>
                </label>
                <label className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 ${provider === "gemini" ? "border-border bg-surface-3" : "border-border/60 bg-surface-2 opacity-70"}`}>
                  <input
                    type="checkbox"
                    className="mt-0.5 rounded border-border"
                    checked={useAsVoicePath}
                    onChange={(e) => setUseAsVoicePath(e.target.checked)}
                    disabled={provider !== "gemini"}
                  />
                  <span className="text-[11px] leading-snug text-fg-subtle">
                    Voice-capable path
                  </span>
                </label>
              </div>

              {test && (
                <div className={`rounded-xl border px-3 py-2.5 text-sm flex items-start gap-2 ${
                  test.ok
                    ? "border-emerald-700/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-rose-700/40 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                }`}>
                  {test.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}
                  <span>{test.ok ? `Connection validated. ${test.models?.length ?? 0} models available.` : test.error}</span>
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-border bg-surface-2 p-4 sm:p-5 space-y-4 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-accent/15 text-accent">
                  <Bot size={16} />
                </span>
                <div>
                  <h2 className="text-sm font-semibold">3. Create your first agent</h2>
                  <p className="text-[11px] text-fg-faint">Pick a starting style. You can refine this later in the Agents panel.</p>
                </div>
              </div>

              <label className="block">
                <span className="text-xs text-fg-subtle mb-1 block">Agent name</span>
                <input
                  className="w-full rounded-xl border border-border bg-surface-3 px-3 py-2 text-sm"
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="My Assistant"
                />
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {(Object.entries(AGENT_STYLES) as Array<[AgentStyle, typeof AGENT_STYLES[AgentStyle]]>).map(([key, option]) => {
                  const Icon = option.icon;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setAgentStyle(key)}
                      className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                        agentStyle === key
                          ? "border-accent/60 bg-accent/15 shadow-sm"
                          : "border-border bg-surface-3"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-surface text-fg-subtle border border-border">
                          <Icon size={14} />
                        </span>
                        <span className="text-sm font-medium">{option.label}</span>
                      </div>
                      <div className="mt-2 text-[11px] text-fg-faint leading-snug">{option.hint}</div>
                    </button>
                  );
                })}
              </div>

              <label className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 ${provider === "gemini" && reuseGoogleKey ? "border-border bg-surface-3" : "border-border/60 bg-surface-2 opacity-70"}`}>
                <input
                  type="checkbox"
                  className="mt-0.5 rounded border-border"
                  checked={voiceEnabled}
                  onChange={(e) => setVoiceEnabled(e.target.checked)}
                  disabled={!(provider === "gemini" && reuseGoogleKey)}
                />
                <span className="text-[11px] leading-snug text-fg-subtle">
                  Enable voice for this first agent. This lights up when your setup can reuse the Gemini key for Google AI features without extra credential steps.
                </span>
              </label>
            </section>
          </div>

          <div className="space-y-5 xl:sticky xl:top-4 self-start">
            <ModelFeatureGuide
              provider={provider}
              modelId={modelId}
              models={models}
              integrations={effectiveIntegrations}
              title="Feature signals"
              description="These icons update as you choose a provider and model, so you can see what ships with this setup before saving it."
            />

            <section className="rounded-2xl border border-border bg-surface-2 p-4 shadow-sm space-y-3">
              <div>
                <h2 className="text-sm font-semibold">Ready to continue?</h2>
                <p className="mt-1 text-[11px] text-fg-faint leading-snug">
                  This will save your profile, create or update the default model, and create or update your main agent.
                </p>
              </div>

              {saveError && (
                <div className="rounded-xl border border-rose-700/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
                  {saveError}
                </div>
              )}

              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !canSave}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                {saving ? <Loader2 size={15} className="animate-spin" /> : null}
                {context === "setup" ? "Finish setup" : "Save setup and open chat"}
              </button>

              <div className="rounded-xl border border-border bg-surface-3 px-3 py-2.5 text-[11px] text-fg-faint leading-snug">
                Normal mode keeps this flow simple. Advanced mode is still available later if you want deeper tuning.
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
