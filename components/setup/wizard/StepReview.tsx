"use client";
import { Sparkles } from "lucide-react";
import type { IntegrationStatus, ModelConfig, UserProfile } from "@/api/types";
import { ModelFeatureGuide } from "@/components/models/ModelFeatureGuide";
import { AGENT_STYLES, PROFILE_PRESETS, PROVIDER_INFO, type AgentStyle, type Provider } from "./constants";
import { StepShell } from "./StepShell";

interface StepReviewProps {
  name: string;
  about: string;
  preset: NonNullable<UserProfile["preset"]>;
  provider: Provider;
  modelId: string;
  reuseGoogleKey: boolean;
  useAsChatDefault: boolean;
  useAsEmbeddingDefault: boolean;
  useAsVoicePath: boolean;
  agentName: string;
  agentStyle: AgentStyle;
  voiceEnabled: boolean;
  models: ModelConfig[];
  integrations: IntegrationStatus[];
}

export function StepReview(props: StepReviewProps) {
  const {
    name, about, preset, provider, modelId,
    reuseGoogleKey, useAsChatDefault, useAsEmbeddingDefault, useAsVoicePath,
    agentName, agentStyle, voiceEnabled, models, integrations,
  } = props;
  const presetInfo = PROFILE_PRESETS.find((p) => p.value === preset);
  const providerInfo = PROVIDER_INFO[provider];
  const style = AGENT_STYLES[agentStyle];

  return (
    <StepShell
      icon={<Sparkles size={18} />}
      eyebrow="Step 4 · Review"
      title="Confirm and finish setup"
      description="Here's what we'll save. You can revisit any of this later in Profile, Models, and Agents."
    >
      <ReviewRow label="Profile" lines={[
        name || "(no name)",
        presetInfo ? `${presetInfo.label} setup` : undefined,
        about ? "About: " + truncate(about, 120) : "No about text",
      ]} />

      <ReviewRow label="Model" lines={[
        `${providerInfo.label}`,
        `Model: ${modelId}`,
        [
          useAsChatDefault && "default chat",
          useAsEmbeddingDefault && "default embeddings",
          useAsVoicePath && provider === "gemini" && "voice path",
          provider === "gemini" && reuseGoogleKey && "google integration",
        ].filter(Boolean).join(" · ") || "no defaults",
      ]} />

      <ReviewRow label="Agent" lines={[
        agentName || "(no name)",
        style.label,
        voiceEnabled && provider === "gemini" && reuseGoogleKey ? "voice enabled" : "voice disabled",
      ]} />

      <details className="rounded-xl border border-border bg-surface-2/60 px-3 py-2 text-xs text-fg-subtle">
        <summary className="cursor-pointer font-medium text-fg">Feature signals for this model</summary>
        <div className="mt-3">
          <ModelFeatureGuide
            provider={provider}
            modelId={modelId}
            models={models}
            integrations={integrations}
            title=""
            description=""
          />
        </div>
      </details>
    </StepShell>
  );
}

function ReviewRow({ label, lines }: { label: string; lines: Array<string | false | undefined> }) {
  return (
    <div className="rounded-xl border border-border bg-surface-3 px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-faint">{label}</div>
      <div className="mt-1 space-y-0.5">
        {lines.filter(Boolean).map((line, i) => (
          <div key={i} className="text-sm text-fg">{line}</div>
        ))}
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
