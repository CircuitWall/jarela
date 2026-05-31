"use client";

import { Database, Eye, FileText, Globe, MessageSquare, Mic, Wrench } from "lucide-react";
import type { IntegrationStatus, ModelConfig } from "@/api/types";
import { CapBadges } from "./CapBadges";
import { computeFeatureReadiness } from "@/lib/ui/feature-readiness";

function FeatureCard({
  title,
  description,
  enabled,
  icon: Icon,
}: {
  title: string;
  description: string;
  enabled: boolean;
  icon: typeof MessageSquare;
}) {
  return (
    <div className={`rounded-lg border px-3 py-2.5 transition-colors ${
      enabled
        ? "border-emerald-500/30 bg-emerald-500/10"
        : "border-border bg-surface-3/70"
    }`}>
      <div className="flex items-center gap-2">
        <span className={`inline-flex h-7 w-7 items-center justify-center rounded-md border ${
          enabled
            ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            : "border-border bg-surface text-fg-faint"
        }`}>
          <Icon size={14} />
        </span>
        <div className="min-w-0">
          <div className={`text-xs font-medium ${enabled ? "text-fg" : "text-fg-subtle"}`}>{title}</div>
          <div className={`text-[10px] uppercase tracking-wide ${enabled ? "text-emerald-700 dark:text-emerald-300" : "text-fg-faint"}`}>
            {enabled ? "ready" : "not detected"}
          </div>
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-snug text-fg-faint">{description}</p>
    </div>
  );
}

interface Props {
  provider: string;
  modelId: string;
  models?: ModelConfig[];
  integrations?: IntegrationStatus[];
  title?: string;
  description?: string;
}

export function ModelFeatureGuide({
  provider,
  modelId,
  models = [],
  integrations = [],
  title = "What This Model Unlocks",
  description = "Pick a provider/model once here and the compatible app features light up based on what this installation can already use.",
}: Props) {
  const trimmedModelId = modelId.trim();
  if (!trimmedModelId) return null;

  const readiness = computeFeatureReadiness({
    models,
    integrations,
    selectedProvider: provider,
    selectedModelId: trimmedModelId,
  });

  if (!readiness.selectedModelCaps) return null;

  const featureCards = [
    {
      title: "General chat",
      description: "Good baseline conversational model for agents and everyday chat.",
      enabled: true,
      icon: MessageSquare,
    },
    {
      title: "Images and screenshots",
      description: "Lets agents inspect screenshots, bridge images, and file attachments visually.",
      enabled: readiness.selectedModelCaps.vision,
      icon: Eye,
    },
    {
      title: "Document and file input",
      description: "Useful when the model needs to read uploaded files and richer document payloads.",
      enabled: readiness.selectedModelCaps.files,
      icon: FileText,
    },
    {
      title: "Voice and audio workflows",
      description: readiness.hasGoogleIntegration
        ? "Best fit for voice-oriented setups and audio-aware experiences."
        : "Requires the existing Google AI integration; without it, voice would need extra setup.",
      enabled: readiness.voiceReady,
      icon: Mic,
    },
    {
      title: "Tool calling",
      description: "Lets agents use tools reliably for actions, retrieval, and automations.",
      enabled: readiness.selectedModelCaps.tools,
      icon: Wrench,
    },
    {
      title: "Built-in web search",
      description: "Provider-native web retrieval when the selected model supports it.",
      enabled: readiness.selectedModelCaps.web_search,
      icon: Globe,
    },
    {
      title: "Documents semantic search",
      description: readiness.documentsReady
        ? "Useful for embeddings-backed recall in the Documents panel."
        : "Needs an embeddings-capable model already available in this installation.",
      enabled: readiness.documentsReady,
      icon: Database,
    },
  ];

  return (
    <div className="rounded-xl border border-border bg-surface-3/60 p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-fg-muted uppercase tracking-wide">{title}</p>
          <p className="text-[11px] text-fg-faint mt-1 leading-snug">{description}</p>
        </div>
        <CapBadges provider={provider} modelId={trimmedModelId} size="sm" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {featureCards.map((feature) => (
          <FeatureCard
            key={feature.title}
            title={feature.title}
            description={feature.description}
            enabled={feature.enabled}
            icon={feature.icon}
          />
        ))}
      </div>
    </div>
  );
}
