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
}

export function StepReview({ name, about, preset, models, agents, integrations }: StepReviewProps) {
  const presetInfo = PROFILE_PRESETS.find((p) => p.value === preset);
  const defaultModel = models.find((m) => m.is_default) ?? models[0] ?? null;
  const defaultAgent = agents.find((a) => a.is_default) ?? agents[0] ?? null;

  return (
    <StepShell
      icon={<Sparkles size={18} />}
      eyebrow="Step 5 · Review"
      title="You're all set"
      description="Quick recap of what we'll save. You can revisit any of this later from Profile, Models, and Agents."
    >
      <ReviewSection
        icon={<User size={14} />}
        label="Profile"
        primary={name || "(no name)"}
        secondary={presetInfo ? `${presetInfo.label} setup` : undefined}
        tertiary={about ? `About: ${truncate(about, 140)}` : "No about text"}
      />

      <ReviewSection
        icon={<Cpu size={14} />}
        label={`Models · ${models.length}`}
        primary={defaultModel ? defaultModel.name : "No models configured"}
        secondary={defaultModel ? `${defaultModel.provider} · ${defaultModel.model_id}` : undefined}
        tertiary={
          models.length > 1
            ? `+${models.length - 1} more model${models.length - 1 === 1 ? "" : "s"}`
            : undefined
        }
      />

      <ReviewSection
        icon={<Bot size={14} />}
        label={`Agents · ${agents.length}`}
        primary={defaultAgent ? defaultAgent.name : "No agents configured"}
        secondary={
          defaultAgent
            ? [
                defaultAgent.model_config_name ?? "automatic routing",
                defaultAgent.voice_enabled ? "voice on" : undefined,
              ]
                .filter(Boolean)
                .join(" · ")
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
          <summary className="cursor-pointer font-medium text-fg">Feature signals for the default model</summary>
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
