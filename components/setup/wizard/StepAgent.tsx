"use client";
import { Bot } from "lucide-react";
import { AGENT_STYLES, type AgentStyle, type Provider } from "./constants";
import { StepShell } from "./StepShell";

interface StepAgentProps {
  agentName: string;
  onAgentNameChange: (v: string) => void;
  agentStyle: AgentStyle;
  onAgentStyleChange: (s: AgentStyle) => void;
  voiceEnabled: boolean;
  onVoiceEnabledChange: (v: boolean) => void;
  provider: Provider;
  reuseGoogleKey: boolean;
}

export function StepAgent({
  agentName, onAgentNameChange,
  agentStyle, onAgentStyleChange,
  voiceEnabled, onVoiceEnabledChange,
  provider, reuseGoogleKey,
}: StepAgentProps) {
  const voiceAvailable = provider === "gemini" && reuseGoogleKey;
  return (
    <StepShell
      icon={<Bot size={18} />}
      eyebrow="Step 3 · Agent"
      title="Create your first agent"
      description="Pick a starting style — you can refine identity, instructions, and tools later in the Agents panel."
    >
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-fg-subtle">Agent name</span>
        <input
          className="w-full rounded-xl border border-border bg-surface-3 px-3 py-2.5 text-sm focus:border-accent focus:outline-none"
          value={agentName}
          onChange={(e) => onAgentNameChange(e.target.value)}
          placeholder="My Assistant"
        />
      </label>

      <div>
        <span className="mb-2 block text-xs font-medium text-fg-subtle">Starting style</span>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(Object.entries(AGENT_STYLES) as Array<[AgentStyle, typeof AGENT_STYLES[AgentStyle]]>).map(([key, option]) => {
            const Icon = option.icon;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onAgentStyleChange(key)}
                className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                  agentStyle === key
                    ? "border-accent/60 bg-accent/15 shadow-sm"
                    : "border-border bg-surface-3 hover:border-fg-faint"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-surface text-fg-subtle">
                    <Icon size={14} />
                  </span>
                  <span className="text-sm font-medium">{option.label}</span>
                </div>
                <div className="mt-2 text-[11px] leading-snug text-fg-faint">{option.hint}</div>
              </button>
            );
          })}
        </div>
      </div>

      <label className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 ${voiceAvailable ? "border-border bg-surface-3" : "border-border/60 bg-surface-2 opacity-70"}`}>
        <input
          type="checkbox"
          className="mt-0.5 rounded border-border"
          checked={voiceEnabled}
          onChange={(e) => onVoiceEnabledChange(e.target.checked)}
          disabled={!voiceAvailable}
        />
        <span className="text-[11px] leading-snug text-fg-subtle">
          Enable voice for this agent. Available when your Gemini key can be reused for Google AI features.
        </span>
      </label>
    </StepShell>
  );
}
