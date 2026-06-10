"use client";
import { UserRound } from "lucide-react";
import type { UserProfile } from "@/api/types";
import { MarkdownTextarea } from "@/components/ui/MarkdownTextarea";
import { PROFILE_PRESETS } from "./constants";
import { StepShell } from "./StepShell";

interface StepProfileProps {
  name: string;
  onNameChange: (v: string) => void;
  about: string;
  onAboutChange: (v: string) => void;
  preset: NonNullable<UserProfile["preset"]>;
  onPresetChange: (v: NonNullable<UserProfile["preset"]>) => void;
}

export function StepProfile({ name, onNameChange, about, onAboutChange, preset, onPresetChange }: StepProfileProps) {
  return (
    <StepShell
      icon={<UserRound size={18} />}
      eyebrow="Step 1 · About you"
      title="Tell us who the assistant is helping"
      description="This shapes the tone, the panels you see, and how the assistant introduces itself."
    >
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-fg-subtle">Your name</span>
        <input
          className="w-full rounded-xl border border-border bg-surface-3 px-3 py-2.5 text-sm focus:border-accent focus:outline-none"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Your name"
          autoFocus
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-fg-subtle">About you (optional)</span>
        <MarkdownTextarea
          className="min-h-[7rem] w-full resize-y rounded-xl border border-border bg-surface-3 px-3 py-2.5 text-sm"
          value={about}
          onChange={onAboutChange}
          rows={5}
          placeholder="What should your assistant know about how you work and what you care about?"
        />
      </label>

      <div>
        <span className="mb-2 block text-xs font-medium text-fg-subtle">What kind of setup do you want?</span>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {PROFILE_PRESETS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onPresetChange(option.value)}
              className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                preset === option.value
                  ? "border-accent/60 bg-accent/15 shadow-sm"
                  : "border-border bg-surface-3 hover:border-fg-faint"
              }`}
            >
              <div className="text-sm font-medium">{option.label}</div>
              <div className="mt-1 text-[11px] leading-snug text-fg-faint">{option.hint}</div>
            </button>
          ))}
        </div>
      </div>
    </StepShell>
  );
}
