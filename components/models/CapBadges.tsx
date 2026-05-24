"use client";
import { Braces, Eye, FileText, Globe, Mic, Wrench, Zap, type LucideIcon } from "lucide-react";
import { modelCapabilities, type ModelCapabilities } from "@/lib/providers/capabilities";

type CapKey = keyof ModelCapabilities;

const CAP_META: Record<CapKey, { icon: LucideIcon; label: string }> = {
  vision:     { icon: Eye,      label: "Vision (image input)" },
  files:      { icon: FileText, label: "File / document input" },
  audio:      { icon: Mic,      label: "Audio / voice input" },
  tools:      { icon: Wrench,   label: "Tool calling" },
  web_search: { icon: Globe,    label: "Built-in web search" },
  json_mode:  { icon: Braces,   label: "Structured JSON output" },
  streaming:  { icon: Zap,      label: "Streaming responses" },
};

const CAP_ORDER: CapKey[] = ["vision", "files", "audio", "tools", "web_search", "json_mode", "streaming"];

interface Props {
  caps?: ModelCapabilities;
  provider?: string;
  modelId?: string;
  size?: "xs" | "sm";
}

export function CapBadges({ caps, provider, modelId, size = "xs" }: Props) {
  const resolved = caps ?? (provider && modelId ? modelCapabilities(provider, modelId) : null);
  if (!resolved) return null;
  const active = CAP_ORDER.filter((k) => resolved[k]);
  if (!active.length) return null;
  const box = size === "sm" ? "w-5 h-5" : "w-4 h-4";
  const icon = size === "sm" ? "w-3 h-3" : "w-2.5 h-2.5";
  return (
    <span className="inline-flex flex-wrap gap-0.5 align-middle">
      {active.map((k) => {
        const { icon: Icon, label } = CAP_META[k];
        return (
          <span
            key={k}
            title={label}
            aria-label={label}
            className={`inline-flex items-center justify-center ${box} rounded bg-surface text-fg-subtle border border-border`}
          >
            <Icon className={icon} strokeWidth={2} aria-hidden />
          </span>
        );
      })}
    </span>
  );
}
