import { useEffect, useRef, useState } from "react";
import type { AgentConfig, AgentConfigIn } from "@/api/types";
import { useTools } from "@/hooks/useTools";
import { isBasicToolCategory } from "@/lib/tools/categories";
import { MBTI_PRESETS, type MbtiType } from "@/lib/agents/adaptive-persona-presets";
import { useAgentExternalData } from "./useAgentExternalData";
import { useAgentToolHandlers } from "./useAgentToolHandlers";

type TierOverride = { hot: number; warm: number; facts: number } | null;
type AntiHallucMode = "" | "off" | "regex" | "model";
type CitationStrictness = "off" | "informational" | "standard" | "strict";
// "" = inherit global policy, other values = per-agent override
type RouterPolicy = "" | "cheap" | "fast" | "balanced" | "quality";
// null = inherit global mode, true/false = per-agent force on/off
type RouterEnabled = boolean | null;

export type AgentEditorForm = ReturnType<typeof useAgentEditorForm>;

// Flat composition hook. Each useState is an orthogonal form field —
// splitting further would add seams without simplifying anything.
export function useAgentEditorForm(agent: AgentConfig | undefined) {
  const { tools } = useTools();
  const iconInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(agent?.name ?? "");
  const [icon, setIcon] = useState<string | null>(agent?.icon ?? null);
  const [identity, setIdentity] = useState(agent?.identity ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [isDefault, setIsDefault] = useState<boolean>(agent?.is_default ?? false);
  const [modelConfigName, setModelConfigName] = useState<string>(agent?.model_config_name ?? "");
  const [selectedTools, setSelectedTools] = useState<string[]>(agent?.tools ?? []);
  const [toolCredentials, setToolCredentials] = useState<Record<string, string>>(
    agent?.tool_credentials ?? {},
  );
  // Imperative setter for the per-tool credential dropdown. Passing
  // `null` clears the override so the resolver falls back to the
  // integration's default credential.
  const setToolCredentialFor = (toolName: string, credentialId: string | null) => {
    setToolCredentials((prev) => {
      const next = { ...prev };
      if (credentialId) next[toolName] = credentialId;
      else delete next[toolName];
      return next;
    });
  };
  const [delegateTargets, setDelegateTargets] = useState<string[]>(agent?.delegate_targets ?? []);
  const [harnessId, setHarnessId] = useState<string>(agent?.harness_id ?? "");
  const [antiHallucMode, setAntiHallucMode] = useState<AntiHallucMode>(agent?.anti_hallucination_mode ?? "");
  const [antiHallucModel, setAntiHallucModel] = useState<string>(agent?.anti_hallucination_model_config ?? "");
  const [citationStrictness, setCitationStrictness] = useState<CitationStrictness>(agent?.citation_strictness ?? "off");
  // ADR-0043. `null` = inherit from the model; only flips to non-null when
  // the user drags a handle, so saving an unmodified agent keeps inherit.
  const [tierOverride, setTierOverride] = useState<TierOverride>(agent?.context_tier_proportions ?? null);
  const [adaptivePersonaEnabled, setAdaptivePersonaEnabled] = useState<boolean>(agent?.adaptive_persona_enabled ?? false);
  const [adaptiveMbti, setAdaptiveMbti] = useState<MbtiType>(initialMbti(agent?.adaptive_mbti));
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(agent?.voice_enabled ?? false);
  const [voiceModel, setVoiceModel] = useState<string>(agent?.voice_model ?? "gemini-2.5-flash-preview-tts");
  const [voiceName, setVoiceName] = useState<string>(agent?.voice_name ?? "Kore");
  const [voiceSttModel, setVoiceSttModel] = useState<string>(agent?.voice_stt_model ?? "gemini-2.5-flash");
  const [voiceAutoSpeak, setVoiceAutoSpeak] = useState<boolean>(agent?.voice_auto_speak ?? true);
  const [routerPolicy, setRouterPolicy] = useState<RouterPolicy>(agent?.router_policy ?? "");
  const [routerEnabled, setRouterEnabled] = useState<RouterEnabled>(agent?.router_enabled ?? null);
  const external = useAgentExternalData(agent?.id);
  const handlers = useAgentToolHandlers(tools, setSelectedTools);
  useEffect(() => {
    const defaults = tools
      .filter((tool) => tool.status !== "disabled" && tool.status !== "unavailable" && isBasicToolCategory(tool.category))
      .map((tool) => tool.name);
    if (defaults.length === 0) return;
    setSelectedTools((prev) => {
      const next = new Set(prev);
      for (const name of defaults) next.add(name);
      return next.size === prev.length ? prev : [...next];
    });
  }, [tools]);
  const fields = {
    name, setName, icon, setIcon, identity, setIdentity, instructions, setInstructions,
    isDefault, setIsDefault, iconInputRef, handleIconFile: handleIconFileFor(setIcon),
    modelConfigName, setModelConfigName, tools, selectedTools,
    toolCredentials, setToolCredentialFor,
    delegateTargets, setDelegateTargets, harnessId, setHarnessId,
    antiHallucMode, setAntiHallucMode, antiHallucModel, setAntiHallucModel,
    citationStrictness, setCitationStrictness, tierOverride, setTierOverride,
    adaptivePersonaEnabled, setAdaptivePersonaEnabled, adaptiveMbti, setAdaptiveMbti,
    voiceEnabled, setVoiceEnabled, voiceModel, setVoiceModel,
    voiceName, setVoiceName, voiceSttModel, setVoiceSttModel,
    voiceAutoSpeak, setVoiceAutoSpeak,
    routerPolicy, setRouterPolicy, routerEnabled, setRouterEnabled,
  };
  return { ...fields, ...external, ...handlers, buildPayload: () => buildAgentPayload(fields) };
}

function initialMbti(value: string | null | undefined): MbtiType {
  const v = value ?? "INTJ";
  return (v in MBTI_PRESETS ? v : "INTJ") as MbtiType;
}

function handleIconFileFor(setIcon: (v: string | null) => void) {
  return (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setIcon(reader.result as string);
    reader.readAsDataURL(file);
  };
}

interface PayloadFields {
  name: string; icon: string | null; identity: string; instructions: string;
  isDefault: boolean; modelConfigName: string; selectedTools: string[];
  toolCredentials: Record<string, string>;
  delegateTargets: string[]; harnessId: string; tierOverride: TierOverride;
  antiHallucMode: AntiHallucMode; antiHallucModel: string;
  citationStrictness: CitationStrictness;
  adaptivePersonaEnabled: boolean; adaptiveMbti: MbtiType;
  voiceEnabled: boolean; voiceModel: string; voiceName: string;
  voiceSttModel: string; voiceAutoSpeak: boolean;
  routerPolicy: RouterPolicy; routerEnabled: RouterEnabled;
}

function buildAgentPayload(f: PayloadFields): AgentConfigIn {
  return {
    name: f.name.trim(),
    icon: f.icon ?? null,
    identity: f.identity.trim(),
    instructions: f.instructions.trim(),
    tools: f.selectedTools,
    model_config_name: f.modelConfigName || null,
    is_default: f.isDefault,
    adaptive_persona_enabled: f.adaptivePersonaEnabled,
    adaptive_mbti: f.adaptiveMbti,
    voice_enabled: f.voiceEnabled,
    voice_model: f.voiceModel,
    voice_name: f.voiceName,
    voice_stt_model: f.voiceSttModel,
    voice_auto_speak: f.voiceAutoSpeak,
    harness_id: f.harnessId || null,
    delegate_targets: f.delegateTargets,
    context_tier_proportions: f.tierOverride,
    anti_hallucination_mode: f.antiHallucMode === "" ? null : f.antiHallucMode,
    anti_hallucination_model_config: f.antiHallucModel.trim() === "" ? null : f.antiHallucModel.trim(),
    citation_strictness: f.citationStrictness,
    // Drop overrides for tools the user has since disabled — the dead
    // entries would never be read but would clutter the persisted JSON.
    tool_credentials: pruneToolCredentials(f.toolCredentials, f.selectedTools),
    router_policy: f.routerPolicy === "" ? null : f.routerPolicy,
    router_enabled: f.routerEnabled,
  };
}

function pruneToolCredentials(
  map: Record<string, string>,
  selected: string[],
): Record<string, string> {
  const allowed = new Set(selected);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) if (allowed.has(k)) out[k] = v;
  return out;
}
