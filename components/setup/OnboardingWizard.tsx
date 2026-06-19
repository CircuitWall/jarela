"use client";

import { ArrowLeft, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/api/client";
import type {
  AgentConfig,
  IntegrationStatus,
  ModelConfig,
  UserProfile,
} from "@/api/types";
import { useAppContext } from "@/contexts/AppContext";
import { getAppName } from "@/lib/env/app-config";
import { Logo } from "@/components/ui/Logo";
import { StepAgent } from "./wizard/StepAgent";
import { StepModel } from "./wizard/StepModel";
import { StepProfile } from "./wizard/StepProfile";
import { StepReview } from "./wizard/StepReview";
import { WizardStepper, type StepInfo } from "./wizard/WizardStepper";
import { errorMessage } from "@/lib/utils/error";

interface Props {
  context: "setup" | "profile";
}

const STEPS: StepInfo[] = [
  { id: "profile", title: "About you", short: "Profile" },
  { id: "model", title: "Model", short: "Model" },
  { id: "agent", title: "Agent", short: "Agent" },
  { id: "review", title: "Review", short: "Review" },
];

export function OnboardingWizard({ context }: Props) {
  const { state, dispatch } = useAppContext();
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);

  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [preset, setPreset] =
    useState<NonNullable<UserProfile["preset"]>>("home");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const refreshModels = useCallback(async () => {
    const rows = await api.models.list({ force: true }).catch(() => [] as ModelConfig[]);
    setModels(rows);
  }, []);
  const refreshAgents = useCallback(async () => {
    const rows = await api.agents.list({ force: true }).catch(() => [] as AgentConfig[]);
    setAgents(rows);
  }, []);
  const refreshIntegrations = useCallback(async () => {
    const res = await api.integrations
      .list()
      .then((r) => r.statuses)
      .catch(() => [] as IntegrationStatus[]);
    setIntegrations(res);
  }, []);

  const handleModelsChanged = useCallback(() => {
    void refreshModels();
    void refreshIntegrations();
  }, [refreshIntegrations, refreshModels]);
  const handleAgentsChanged = useCallback(() => {
    void refreshAgents();
  }, [refreshAgents]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [profileData, modelRows, agentRows, integrationRows] =
          await Promise.all([
            api.profile.get().catch(() => null),
            api.models.list().catch(() => []),
            api.agents.list().catch(() => []),
            api.integrations
              .list()
              .then((res) => res.statuses)
              .catch(() => []),
          ]);
        if (cancelled) return;
        setModels(modelRows);
        setAgents(agentRows);
        setIntegrations(integrationRows);
        setName(profileData?.name ?? "");
        setAbout(profileData?.about ?? "");
        setPreset(
          (profileData?.preset as NonNullable<UserProfile["preset"]> | null) ??
            "home",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const hasName = name.trim().length > 0;
  const hasModel = models.length > 0;
  const hasAgent = agents.length > 0;
  const canSave = hasName && hasModel && hasAgent;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.profile.update({
        name: name.trim(),
        about: about.trim(),
        preset,
      });
      const targetAgent = agents.find((a) => a.is_default) ?? agents[0] ?? null;
      if (context === "setup") {
        window.location.href = "/";
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
    if (step === 1) return hasModel;
    if (step === 2) return hasAgent;
    return canSave;
  })();
  const isLast = step === STEPS.length - 1;

  if (loading) {
    return (
      <div
        className={`flex items-center justify-center ${fullScreen ? "min-h-screen" : "h-full"} bg-surface text-fg`}
      >
        <div className="inline-flex items-center gap-2 text-sm text-fg-faint">
          <Loader2 size={16} className="animate-spin" /> Loading setup
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
                  ? "First launch setup"
                  : state.experienceMode === "essential"
                    ? "Guided setup"
                    : "Profile"}
              </div>
              <div className="truncate text-sm font-medium">
                {fullScreen ? `Set up ${getAppName()}` : "Set up your assistant"}
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
          <StepModel models={models} onChanged={handleModelsChanged} />
        )}
        {step === 2 && (
          <StepAgent
            agents={agents}
            models={models}
            onChanged={handleAgentsChanged}
          />
        )}
        {step === 3 && (
          <StepReview
            name={name}
            about={about}
            preset={preset}
            models={models}
            agents={agents}
            integrations={integrations}
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
          <p className="mx-auto mt-2 max-w-2xl text-center text-xs text-rose-600 dark:text-rose-300 sm:hidden">
            {saveError}
          </p>
        )}
      </footer>
    </main>
  );
}
