import { Brain, Briefcase, Sparkles, Wand2 } from "lucide-react";
import type { UserProfile } from "@/api/types";

export type Provider = "anthropic" | "openai" | "gemini" | "deepseek";

export const PROVIDER_INFO: Record<
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

export const PROVIDER_SIGNALS: Record<Provider, {
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

export function signalTone(level: "strong" | "partial" | "limited"): string {
  if (level === "strong") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (level === "partial") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-border bg-surface-3 text-fg-faint";
}

export const PROFILE_PRESETS: Array<{ value: NonNullable<UserProfile["preset"]>; label: string; hint: string }> = [
  { value: "home", label: "Home", hint: "Personal AI, mail, calendar, and everyday tasks" },
  { value: "work", label: "Work", hint: "Project coordination, docs, issues, and team workflows" },
  { value: "dev", label: "Developer", hint: "Coding, debugging, tools, and infrastructure-heavy usage" },
  { value: "custom", label: "Everything", hint: "Show the full surface without category filtering" },
];

export const AGENT_STYLES = {
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

export type AgentStyle = keyof typeof AGENT_STYLES;

export interface TestResult {
  ok: boolean;
  models?: string[];
  error?: string;
}

export function supportedProvider(value: string | null | undefined): Provider {
  if (value === "anthropic" || value === "openai" || value === "gemini" || value === "deepseek") return value;
  return "anthropic";
}
