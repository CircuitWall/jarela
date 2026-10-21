"use client";
import { Bot, Cpu, Sparkles, User } from "lucide-react";
import type { AgentConfig, IntegrationStatus, ModelConfig, UserProfile } from "@/api/types";
import { ModelFeatureGuide } from "@/components/models/ModelFeatureGuide";
import { PROFILE_PRESETS } from "./constants";
import { StepShell } from "./StepShell";

interface StepReviewProps {
  name: string;
  about: string;
  preset: NonNullable<UserProfile["preset"]>;
  models: ModelConfig[];
  agents: AgentConfig[];
  integrations: IntegrationStatus[];
  starterAgent?: { name: string; modelConfigName: string };
  readOnlySettings?: boolean;
}

export function StepReview({ name, about, preset, models, agents, integrations, starterAgent, readOnlySettings = false }: StepReviewProps) {
  const presetInfo = PROFILE_PRESETS.find((p) => p.value === preset);
  const enabledModels = models.filter((model) => model.enabled !== false);
  const defaultModel = enabledModels.find((model) => model.is_default) ?? enabledModels[0] ?? null;
  const defaultAgent = agents.find((a) => a.is_default) ?? agents[0] ?? null;
  const agentCount = agents.length + (starterAgent && !defaultAgent ? 1 : 0);

  return (
    <StepShell
      icon={<Sparkles size={18} />}
      eyebrow="Step 5 · Review"
      title="Here's what we're starting with"
      description={readOnlySettings
        ? "Your profile changes will be saved. Your provider, model, and assistant will stay just as they are."
        : "Take a look at your starting setup. We can adjust things together as we go."}
    >
      <ReviewSection
        icon={<User size={14} />}
        label="Profile"
        primary={name || "(no name)"}
        secondary={presetInfo ? `${presetInfo.label} setup` : undefined}
        tertiary={about ? `A little about you: ${truncate(about, 140)}` : "Nothing else shared yet"}
      />

      <ReviewSection
        icon={<Cpu size={14} />}
        label={`Models · ${enabledModels.length}`}
        primary={defaultModel ? defaultModel.name : "No enabled model yet"}
        secondary={defaultModel ? `${defaultModel.provider} · ${defaultModel.model_id}` : undefined}
        tertiary={
          enabledModels.length > 1
            ? `+${enabledModels.length - 1} more model${enabledModels.length - 1 === 1 ? "" : "s"}`
            : undefined
        }
      />

      <ReviewSection
        icon={<Bot size={14} />}
        label={`Agents · ${agentCount}`}
        primary={defaultAgent?.name ?? starterAgent?.name ?? "No assistant yet"}
        secondary={
          defaultAgent
            ? [
                defaultAgent.model_config_name ?? "automatic routing",
                defaultAgent.voice_enabled ? "voice on" : undefined,
              ]
                .filter(Boolean)
                .join(" · ")
            : starterAgent
              ? `${starterAgent.modelConfigName} · ready when you finish`
              : undefined
        }
        tertiary={
          agents.length > 1
            ? `+${agents.length - 1} more agent${agents.length - 1 === 1 ? "" : "s"}`
            : undefined
        }
      />

      {defaultModel && (
        <details className="rounded-xl border border-border bg-surface-2/60 px-3 py-2 text-xs text-fg-subtle">
          <summary className="cursor-pointer font-medium text-fg">What this model can do</summary>
          <div className="mt-3">
            <ModelFeatureGuide
              provider={defaultModel.provider}
              modelId={defaultModel.model_id}
              models={models}
              integrations={integrations}
              title=""
              description=""
            />
          </div>
        </details>
      )}
    </StepShell>
  );
}

function ReviewSection({
  icon,
  label,
  primary,
  secondary,
  tertiary,
}: {
  icon: React.ReactNode;
  label: string;
  primary: string;
  secondary?: string;
  tertiary?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface-3 px-4 py-3">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-faint">
        <span className="text-fg-subtle">{icon}</span>
        {label}
      </div>
      <div className="mt-1 space-y-0.5">
        <div className="text-sm font-medium text-fg">{primary}</div>
        {secondary && <div className="text-xs text-fg-subtle">{secondary}</div>}
        {tertiary && <div className="text-[11px] text-fg-faint">{tertiary}</div>}
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
