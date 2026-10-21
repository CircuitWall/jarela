"use client";

import { ArrowLeft, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/api/client";
import type {
  AgentConfig,
  IntegrationDefinition,
  IntegrationStatus,
  ModelConfig,
  UserProfile,
} from "@/api/types";
import { persistFirstRunChatKickoff, useAppContext } from "@/contexts/AppContext";
import { getAppName } from "@/lib/env/app-config";
import { isBasicToolCategory } from "@/lib/tools/runtime/categories";
import { PROVIDER_TO_INTEGRATION } from "@/lib/providers/provider-integration-map";
import { buildFirstRunAgentInstructions, buildFirstRunKickoff } from "@/lib/agents/first-run-onboarding";
import { rememberFirstRunThread } from "@/lib/ui/first-run-thread";
import { Logo } from "@/components/ui/Logo";
import { StepAgent } from "./wizard/StepAgent";
import { StepCredentials } from "./wizard/StepCredentials";
import { StepModel } from "./wizard/StepModel";
import { StepProfile } from "./wizard/StepProfile";
import { StepReview } from "./wizard/StepReview";
import { WizardStepper, type StepInfo } from "./wizard/WizardStepper";
import { errorMessage } from "@/lib/utils/error";

interface Props {
  context: "setup" | "profile";
  onReady?: () => void;
}

const STEPS: StepInfo[] = [
  { id: "profile", title: "Tell me who you are", short: "You" },
  { id: "credentials", title: "Let's connect a provider", short: "Provider" },
  { id: "model", title: "Let's choose a model", short: "Model" },
  { id: "agent", title: "Give me an identity", short: "Identity" },
  { id: "review", title: "Here's what we're starting with", short: "Review" },
];

export function OnboardingWizard({ context, onReady }: Props) {
  const { state, dispatch } = useAppContext();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [integrationDefs, setIntegrationDefs] = useState<IntegrationDefinition[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [assistantName, setAssistantName] = useState("");
  const [assistantIcon, setAssistantIcon] = useState<string | null>(null);
  const [starterGoal, setStarterGoal] = useState("");
  const [createdAgent, setCreatedAgent] = useState<AgentConfig | null>(null);
  const [preset, setPreset] =
    useState<NonNullable<UserProfile["preset"]>>("home");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const refreshModels = useCallback(async () => {
    try {
      setModels(await api.models.list({ force: true }));
    } catch {
      setLoadError(true);
    }
  }, []);
  const refreshAgents = useCallback(async () => {
    try {
      setAgents(await api.agents.list({ force: true }));
    } catch {
      setLoadError(true);
    }
  }, []);
  const refreshIntegrations = useCallback(async () => {
    try {
      const res = await api.integrations.list();
      setIntegrationDefs(res.definitions);
      setIntegrations(res.statuses);
    } catch {
      setLoadError(true);
    }
  }, []);

  const handleModelsChanged = useCallback(() => {
    void refreshModels();
    void refreshIntegrations();
  }, [refreshIntegrations, refreshModels]);
  const handleProviderConfigured = useCallback((integrationName: string) => {
    setIntegrations((current) => {
      const existing = current.find((status) => status.name === integrationName);
      const configured = {
        name: integrationName,
        configured: true,
        values: existing?.values ?? {},
        updated_at: existing?.updated_at ?? null,
        source: existing?.source,
        rc_synced_at: existing?.rc_synced_at ?? null,
      };
      return [...current.filter((status) => status.name !== integrationName), configured];
    });
    void refreshIntegrations();
  }, [refreshIntegrations]);
  const handleAgentsChanged = useCallback(() => {
    void refreshAgents();
  }, [refreshAgents]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const results = await Promise.allSettled([
          api.profile.get(),
          api.models.list(),
          api.agents.list(),
          api.integrations.list(),
        ]);
        if (cancelled) return;
        const [profileResult, modelResult, agentResult, integrationResult] = results;
        if (profileResult.status === "fulfilled") {
          setName(profileResult.value?.name ?? "");
          setAbout(profileResult.value?.about ?? "");
          setPreset(
            (profileResult.value?.preset as NonNullable<UserProfile["preset"]> | null) ??
              "home",
          );
        }
        if (modelResult.status === "fulfilled") setModels(modelResult.value);
        if (agentResult.status === "fulfilled") setAgents(agentResult.value);
        if (integrationResult.status === "fulfilled") {
          setIntegrationDefs(integrationResult.value.definitions);
          setIntegrations(integrationResult.value.statuses);
        }
        setLoadError(results.some((result) => result.status === "rejected"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  useEffect(() => {
    if (!loading) onReady?.();
  }, [loading, onReady]);

  const hasName = name.trim().length > 0;
  const hasModel = models.some((model) => model.enabled !== false);
  const hasAgent = agents.length > 0 || createdAgent !== null;
  const canSave = hasName && hasModel && (hasAgent || (context === "setup" && assistantName.trim().length > 0));
  const configuredModelProviders = [...new Set(
    Object.entries(PROVIDER_TO_INTEGRATION)
      .filter(([, integration]) => integrations.some((status) => status.name === integration && status.configured))
      .map(([provider]) => provider),
  )];
  const defaultModelProvider = configuredModelProviders.length === 1 ? configuredModelProviders[0] : undefined;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      let targetAgent = createdAgent ?? agents.find((a) => a.is_default) ?? agents[0] ?? null;
      if (context === "setup") {
        if (!targetAgent) {
          const model = models.find((row) => row.is_default) ?? models[0];
          if (!model) throw new Error("Add a model before finishing setup.");
          const availableTools = await api.tools.list({ includeDisabled: true }).catch(() => []);
          const created = await api.agents.create({
            name: assistantName.trim(),
            icon: assistantIcon,
            identity: "A friendly, adaptable personal assistant.",
            instructions: buildFirstRunAgentInstructions(starterGoal.trim()),
            tools: availableTools
              .filter((tool) => tool.status !== "disabled" && tool.status !== "unavailable" && isBasicToolCategory(tool.category))
              .map((tool) => tool.name),
            model_config_name: model.name,
            is_default: true,
          });
          targetAgent = created;
          setCreatedAgent(created);
          setAgents((current) => current.some((row) => row.id === created.id) ? current : [...current, created]);
        }
      }
      await api.profile.update({
        name: name.trim(),
        about: about.trim(),
        preset,
      });
      if (context === "setup") {
        if (!targetAgent) throw new Error("Create your assistant before finishing setup.");
        const firstRunThread = await api.threads.create(targetAgent.id, "Getting to know you");
        rememberFirstRunThread(firstRunThread.thread_id);
        const selectedModel = models.find((model) => model.name === targetAgent.model_config_name)
          ?? models.find((model) => model.is_default)
          ?? models[0];
        dispatch({ type: "SELECT_THREAD", threadId: firstRunThread.thread_id, agentId: targetAgent.id });
        const kickoff = {
          id: `${targetAgent.id}:${Date.now()}`,
          agentId: targetAgent.id,
          message: buildFirstRunKickoff({
            userName: name.trim(),
            about: about.trim(),
            starterGoal: starterGoal.trim(),
            assistantName: targetAgent.name,
            modelProvider: selectedModel?.provider ?? "your chosen provider",
            modelName: selectedModel?.model_id ?? "your selected model",
          }),
        };
        persistFirstRunChatKickoff(kickoff);
        dispatch({ type: "SET_FIRST_RUN_CHAT_KICKOFF", kickoff });
        router.push("/");
        return;
      }
      if (targetAgent) dispatch({ type: "SET_AGENT", agentId: targetAgent.id });
      dispatch({ type: "SET_TAB", tab: "chat" });
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const fullScreen = context === "setup";

  const canAdvance = (() => {
    if (step === 0) return hasName;
    if (step === 1) return true;
    if (step === 2) return hasModel;
    if (step === 3) return context === "setup" ? assistantName.trim().length > 0 : hasAgent;
    return canSave;
  })();
  const isLast = step === STEPS.length - 1;

  if (loading) {
    return (
      <div
        className={`flex items-center justify-center ${fullScreen ? "min-h-screen" : "h-full"} bg-surface text-fg`}
      >
        <div className="inline-flex items-center gap-2 text-sm text-fg-faint">
          <Loader2 size={16} className="animate-spin" /> Getting your setup ready
        </div>
      </div>
    );
  }

  return (
    <main
      className={`flex ${fullScreen ? "min-h-screen" : "h-full"} flex-col bg-surface text-fg`}
    >
      <header className="sticky top-0 z-20 border-b border-border bg-surface/85 px-4 py-3 backdrop-blur-xl sm:px-8">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
          <div className="flex items-center gap-3">
            {fullScreen && <Logo className="h-7 w-auto" />}
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-fg-faint">
                {fullScreen
                  ? "Let's get started"
                  : state.experienceMode === "essential"
                    ? "Let's make this yours"
                    : "Profile"}
              </div>
              <div className="truncate text-sm font-medium">
                {fullScreen ? `Let's set up ${getAppName()}` : "Let's make your assistant yours"}
              </div>
            </div>
            <div className="text-[11px] text-fg-faint">
              Step {step + 1} of {STEPS.length}
            </div>
          </div>
          <WizardStepper
            steps={STEPS}
            current={step}
            onJump={(i) => setStep(i)}
          />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-8 sm:px-6 sm:py-10">
        {loadError && (
          <div className="mx-auto mb-6 flex w-full max-w-2xl items-center justify-between gap-3 rounded-xl border border-rose-500/30 bg-rose-500/5 px-3 py-2.5 text-xs">
            <p role="alert" className="text-rose-700 dark:text-rose-300">
              I couldn&apos;t load a few setup details. Check your connection and try again.
            </p>
            <button
              type="button"
              onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              className="shrink-0 rounded-lg border border-border px-3 py-1.5 font-medium text-fg hover:bg-surface-3"
            >
              Try again
            </button>
          </div>
        )}
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
          <StepCredentials
            definitions={integrationDefs}
            integrations={integrations}
            onChanged={handleModelsChanged}
            onConfigured={handleProviderConfigured}
            readOnly={context === "profile"}
            firstRun={context === "setup"}
          />
        )}
        {step === 2 && (
          <StepModel
            models={models}
            onChanged={handleModelsChanged}
            readOnly={context === "profile"}
            defaultProvider={context === "setup" ? defaultModelProvider : undefined}
          />
        )}
        {step === 3 && (
          <StepAgent
            agents={agents}
            models={models}
            onChanged={handleAgentsChanged}
            readOnly={context === "profile"}
            starter={context === "setup" ? {
              name: assistantName,
              onNameChange: setAssistantName,
              icon: assistantIcon,
              onIconChange: setAssistantIcon,
              goal: starterGoal,
              onGoalChange: setStarterGoal,
            } : undefined}
          />
        )}
        {step === 4 && (
          <StepReview
            name={name}
            about={about}
            preset={preset}
            models={models}
            agents={agents}
            integrations={integrations}
            readOnlySettings={context === "profile"}
            starterAgent={context === "setup" && !createdAgent && agents.length === 0 ? {
              name: assistantName.trim(),
              modelConfigName: models.find((model) => model.is_default)?.name ?? models[0]?.name ?? "",
            } : undefined}
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

          <div className="flex-1" />

          {saveError && isLast && (
            <span className="hidden text-xs text-rose-600 dark:text-rose-300 sm:inline">
              {saveError}
            </span>
          )}

          {isLast ? (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !canSave}
              className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <CheckCircle2 size={14} />
              )}
              {context === "setup" ? "Start our first chat" : "Save and open chat"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
              disabled={!canAdvance}
              className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              Continue <ArrowRight size={14} />
            </button>
          )}
        </div>
        {saveError && isLast && (
          <p className="mx-auto mt-2 max-w-2xl text-center text-xs text-rose-600 dark:text-rose-300 sm:hidden">
            {saveError}
          </p>
        )}
      </footer>
    </main>
  );
}
