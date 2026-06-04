"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, X, Upload } from "lucide-react";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import type { AgentConfig, AgentConfigIn, Harness, ModelConfig, ToolInfo } from "@/api/types";
import { api } from "@/api/client";
import { useAppContext } from "@/contexts/AppContext";
import { useTools } from "@/hooks/useTools";
import { MBTI_PRESETS, MBTI_TYPES, type MbtiType } from "@/lib/agents/adaptive-persona-presets";
import { GEMINI_TTS_MODELS, GEMINI_STT_MODELS, GEMINI_VOICES } from "@/lib/voice/constants";
import { modelSupportsImages, isProviderClassified } from "@/lib/providers/capabilities";
import { pushErrorToast } from "@/lib/ui/error-report";
import { CapBadges } from "@/components/models/CapBadges";
import { MarkdownTextarea } from "@/components/ui/MarkdownTextarea";
import { Select } from "@/components/ui/Select";
import { TierProportionBar } from "./TierProportionBar";
import { computeFeatureReadiness } from "@/lib/ui/feature-readiness";
import type { IntegrationStatus } from "@/api/types";

interface Props {
  agent?: AgentConfig;
  models: ModelConfig[];
  onSave: (data: AgentConfigIn) => Promise<void>;
  onClose: () => void;
}

type ToolPermissionKind = "read" | "write" | "execute";

const READ_PREFIXES = ["get_", "list_", "search_", "read_", "fetch_", "check_", "status_"];
const WRITE_PREFIXES = [
  "create_", "update_", "delete_", "write_", "edit_", "modify_", "move_", "copy_", "mkdir_",
  "set_", "add_", "remove_", "trash_", "cancel_", "upsert_", "transition_", "upload_",
];
const EXECUTE_PREFIXES = ["run_", "exec_", "execute_", "shell_", "script_", "schedule_", "generate_", "trigger_", "propose_"];

function permissionKindForTool(name: string, category?: string): ToolPermissionKind {
  const n = name.toLowerCase();
  if (READ_PREFIXES.some((p) => n.startsWith(p))) return "read";
  if (WRITE_PREFIXES.some((p) => n.startsWith(p))) return "write";
  if (category === "Shell") return "execute";
  if (EXECUTE_PREFIXES.some((p) => n.startsWith(p))) return "execute";
  return "execute";
}

function Section({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2.5 rounded-xl border border-border bg-surface-1/30 p-3">
      <div className="flex items-center gap-2">
        <span className="w-5 h-5 rounded-full bg-accent text-white text-[10px] font-bold flex items-center justify-center shrink-0">
          {step}
        </span>
        <span className="text-xs font-semibold text-fg-muted uppercase tracking-wide">{title}</span>
      </div>
      <div className="ml-7 space-y-2">{children}</div>
    </div>
  );
}

export function AgentEditor({ agent, models, onSave, onClose }: Props) {
  const { state, dispatch } = useAppContext();
  const isFullMode = state.experienceMode === "full";
  const isEdit = !!agent;
  const { tools } = useTools();
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(agent?.name ?? "");
  const [icon, setIcon] = useState<string | null>(agent?.icon ?? null);
  const [modelConfigName, setModelConfigName] = useState<string>(agent?.model_config_name ?? "");
  const [identity, setIdentity] = useState(agent?.identity ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [selectedTools, setSelectedTools] = useState<string[]>(agent?.tools ?? []);
  const [isDefault, setIsDefault] = useState<boolean>(agent?.is_default ?? false);
  const [adaptivePersonaEnabled, setAdaptivePersonaEnabled] = useState<boolean>(agent?.adaptive_persona_enabled ?? false);
  const [adaptiveMbti, setAdaptiveMbti] = useState<MbtiType>(((agent?.adaptive_mbti ?? "INTJ") in MBTI_PRESETS
    ? (agent?.adaptive_mbti ?? "INTJ")
    : "INTJ") as MbtiType);
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(agent?.voice_enabled ?? false);
  const [voiceModel, setVoiceModel] = useState<string>(agent?.voice_model ?? "gemini-2.5-flash-preview-tts");
  const [voiceName, setVoiceName] = useState<string>(agent?.voice_name ?? "Kore");
  const [voiceSttModel, setVoiceSttModel] = useState<string>(agent?.voice_stt_model ?? "gemini-2.5-flash");
  const [voiceAutoSpeak, setVoiceAutoSpeak] = useState<boolean>(agent?.voice_auto_speak ?? true);
  const [harnessId, setHarnessId] = useState<string>(agent?.harness_id ?? "");
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [defaultHarnessId, setDefaultHarnessId] = useState<string>("builtin:default");
  const [delegateTargets, setDelegateTargets] = useState<string[]>(agent?.delegate_targets ?? []);
  // ADR-0043. Per-agent override of the hot/warm/facts split. `null` =
  // inherit from the model. The bar displays the effective value either
  // way; `tierOverride` only flips to non-null once the user actually
  // drags a handle, so saving an unmodified agent keeps the inherit state.
  const [tierOverride, setTierOverride] = useState<{ hot: number; warm: number; facts: number } | null>(
    agent?.context_tier_proportions ?? null,
  );
  // Anti-hallucination detector: per-agent override of the global env
  // setting. "" = inherit (null on the wire). The model field only
  // matters when mode === "model"; when inherit/regex/off it's ignored.
  const [antiHallucMode, setAntiHallucMode] = useState<"" | "off" | "regex" | "model">(
    agent?.anti_hallucination_mode ?? "",
  );
  const [antiHallucModel, setAntiHallucModel] = useState<string>(
    agent?.anti_hallucination_model_config ?? "",
  );
  // Citation enforcement is an independent toggle that re-uses
  // anti_hallucination_model_config as the checker model. When on, the
  // agent's system prompt requires [source](url) links for factual claims
  // and a post-turn checker flags any citation that wasn't actually
  // visited via a tool call in this thread.
  const [requireSourceLinks, setRequireSourceLinks] = useState<boolean>(
    agent?.require_source_links ?? false,
  );
  const [otherAgents, setOtherAgents] = useState<AgentConfig[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.harnesses.list()
      .then((res) => {
        if (cancelled) return;
        setHarnesses(res.harnesses);
        setDefaultHarnessId(res.default_harness_id);
      })
      .catch(() => { /* harness picker silently empty if fetch fails */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.integrations.list()
      .then((res) => {
        if (cancelled) return;
        setIntegrations(res.statuses);
      })
      .catch(() => {
        if (cancelled) return;
        setIntegrations([]);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.agents.list()
      .then((list) => {
        if (cancelled) return;
        setOtherAgents(list.filter((a) => a.id !== agent?.id));
      })
      .catch(() => { /* delegate picker stays empty if fetch fails */ });
    return () => { cancelled = true; };
  }, [agent?.id]);

  useEscapeKey(onClose);

  function handleIconFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setIcon(reader.result as string);
    reader.readAsDataURL(file);
  }

  function toggleTool(toolName: string) {
    setSelectedTools((p) => p.includes(toolName) ? p.filter((n) => n !== toolName) : [...p, toolName]);
  }

  function toggleAllTools() {
    setSelectedTools((p) => p.length === tools.length ? [] : tools.map((t) => t.name));
  }

  // Group tools by category for the sectioned UI. Categories with no tools
  // are omitted automatically. "MCP" is shown last so the user's own MCP-
  // provided tools are visually distinct from the built-in capability blocks.
  // Categories are then bucketed into optional parent groups (e.g. "Work"
  // wraps Atlassian + GitHub) — the API tags each tool with `group` so the
  // UI doesn't need to know which categories live where.
  const groupedTools = useMemo(() => {
    const byCat = new Map<string, ToolInfo[]>();
    const catGroup = new Map<string, string | null>();
    for (const t of tools) {
      const cat = t.category ?? "Other";
      const arr = byCat.get(cat) ?? [];
      arr.push(t);
      byCat.set(cat, arr);
      // First tool wins; categories shouldn't span multiple groups in practice.
      if (!catGroup.has(cat)) catGroup.set(cat, t.group ?? null);
    }
    const CATEGORY_ORDER = [
      "Memory", "Documents", "Files", "Shell", "Web", "Images", "Voice",
      "Schedule", "Atlassian", "GitHub", "Mail", "Calendar", "Config", "Other", "MCP",
    ];
    const orderOf = (c: string) => {
      const i = CATEGORY_ORDER.indexOf(c);
      return i === -1 ? 999 : i;
    };

    // Bucket categories by group while preserving the per-category sort order.
    const buckets = new Map<string | null, Array<[string, ToolInfo[]]>>();
    const groupOrder = new Map<string | null, number>();
    for (const [cat, ts] of byCat) {
      const g = catGroup.get(cat) ?? null;
      const arr = buckets.get(g) ?? [];
      arr.push([cat, ts]);
      buckets.set(g, arr);
      // The group's overall sort key is the smallest order value among its
      // categories — so "Work" lands wherever Atlassian/GitHub would have.
      const prev = groupOrder.get(g);
      const here = orderOf(cat);
      if (prev === undefined || here < prev) groupOrder.set(g, here);
    }
    for (const arr of buckets.values()) arr.sort((a, b) => orderOf(a[0]) - orderOf(b[0]));

    for (const arr of buckets.values()) {
      for (const entry of arr) {
        entry[1].sort((a, b) => {
          const scoreDiff = (b.stats?.score ?? 0) - (a.stats?.score ?? 0);
          if (scoreDiff !== 0) return scoreDiff;
          return a.name.localeCompare(b.name);
        });
      }
    }

    return [...buckets.entries()]
      .sort((a, b) => (groupOrder.get(a[0]) ?? 999) - (groupOrder.get(b[0]) ?? 999))
      .map(([group, categories]) => ({ group, categories }));
  }, [tools]);

  const allGroupedCategories = useMemo(
    () => groupedTools.flatMap((g) => g.categories),
    [groupedTools],
  );

  function toggleCategory(category: string, enable: boolean) {
    const names = allGroupedCategories.find(([c]) => c === category)?.[1].map((t) => t.name) ?? [];
    if (names.length === 0) return;
    setSelectedTools((prev) => {
      if (enable) {
        const set = new Set(prev);
        for (const n of names) set.add(n);
        return [...set];
      }
      const remove = new Set(names);
      return prev.filter((n) => !remove.has(n));
    });
  }

  function toggleCategoryPermission(category: string, kind: ToolPermissionKind, enable: boolean) {
    const toolsInCategory = allGroupedCategories.find(([c]) => c === category)?.[1] ?? [];
    const names = toolsInCategory
      .filter((t) => permissionKindForTool(t.name, category) === kind)
      .map((t) => t.name);
    if (names.length === 0) return;
    setSelectedTools((prev) => {
      if (enable) {
        const set = new Set(prev);
        for (const n of names) set.add(n);
        return [...set];
      }
      const remove = new Set(names);
      return prev.filter((n) => !remove.has(n));
    });
  }

  function toggleGroup(group: string, enable: boolean) {
    const names = (groupedTools.find((g) => g.group === group)?.categories ?? [])
      .flatMap(([, ts]) => ts.map((t) => t.name));
    if (names.length === 0) return;
    setSelectedTools((prev) => {
      if (enable) {
        const set = new Set(prev);
        for (const n of names) set.add(n);
        return [...set];
      }
      const remove = new Set(names);
      return prev.filter((n) => !remove.has(n));
    });
  }

  async function handleSave() {
    setError(null);
    if (!name.trim()) { setError("Name is required"); return; }
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        icon: icon ?? null,
        identity: identity.trim(),
        instructions: instructions.trim(),
        tools: selectedTools,
        model_config_name: modelConfigName || null,
        is_default: isDefault,
        adaptive_persona_enabled: adaptivePersonaEnabled,
        adaptive_mbti: adaptiveMbti,
        voice_enabled: voiceEnabled,
        voice_model: voiceModel,
        voice_name: voiceName,
        voice_stt_model: voiceSttModel,
        voice_auto_speak: voiceAutoSpeak,
        harness_id: harnessId || null,
        delegate_targets: delegateTargets,
        context_tier_proportions: tierOverride,
        anti_hallucination_mode: antiHallucMode === "" ? null : antiHallucMode,
        anti_hallucination_model_config: antiHallucModel.trim() === "" ? null : antiHallucModel.trim(),
        require_source_links: requireSourceLinks,
      });
      onClose();
    } catch (e) {
      pushErrorToast({
        title: "Couldn't save agent",
        error: e,
        context: { panel: "agents", action: "agent.save", agent_name: name.trim() },
      });
    } finally {
      setSaving(false);
    }
  }

  const selectedModel = models.find((m) => m.name === modelConfigName);
  const defaultModel = models.find((m) => m.is_default);
  const readiness = computeFeatureReadiness({
    models,
    integrations,
    selectedProvider: selectedModel?.provider,
    selectedModelId: selectedModel?.model_id,
  });
  const mbtiPreset = MBTI_PRESETS[adaptiveMbti];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 p-2 sm:p-4 overflow-y-auto">
      <div className={`bg-surface-2 border border-border rounded-2xl w-full shadow-xl my-2 sm:my-4 ${isFullMode ? "max-w-2xl" : "max-w-xl"}`}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-fg">{isEdit ? "Edit agent" : "New agent"}</h3>
          <button onClick={onClose} className="text-fg-subtle hover:text-fg transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-5">

          {/* Step 1: Identity */}
          <Section step={1} title="Identity">
            <div className="flex items-end gap-3">
              <div className="shrink-0">
                <span className="text-xs text-fg-subtle mb-1 block">Icon</span>
                <button
                  onClick={() => fileRef.current?.click()}
                  className="w-12 h-12 rounded-lg border-2 border-dashed border-border bg-surface-3 flex items-center justify-center hover:border-accent transition-colors overflow-hidden group"
                  title="Upload image"
                >
                  {icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={icon} alt="icon" className="w-full h-full object-cover" />
                  ) : (
                    <Upload size={14} className="text-fg-faint group-hover:text-accent transition-colors" />
                  )}
                </button>
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleIconFile} />
                {icon && (
                  <button onClick={() => setIcon(null)} className="text-[10px] text-fg-faint hover:text-red-700 dark:hover:text-red-400 mt-0.5 block">
                    Remove
                  </button>
                )}
              </div>
              <label className="flex-1 block">
                <span className="text-xs text-fg-subtle mb-1 block">Name</span>
                <input
                  className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Code Reviewer"
                  autoFocus
                />
              </label>
            </div>
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">Persona</span>
              <MarkdownTextarea
                className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent min-h-[4rem] resize-y"
                value={identity}
                onChange={setIdentity}
                rows={3}
                placeholder="You are a senior TypeScript engineer with deep expertise in React and Next.js…"
              />
            </label>
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">Instructions</span>
              <MarkdownTextarea
                className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent min-h-[4rem] resize-y"
                value={instructions}
                onChange={setInstructions}
                rows={3}
                placeholder="Focus on code review, suggest best practices, and explain your reasoning…"
              />
            </label>
          </Section>

          <hr className="border-border" />

          {/* Step 2: Model */}
          <Section step={2} title="Model">
            {!readiness.documentsReady && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200 leading-snug">
                <p>
                  Add a model config that the current installation can use for Documents embeddings if you want semantic document recall.
                </p>
                <p className="mt-1 text-amber-900/90 dark:text-amber-100/90">
                  Compatible setup: OpenAI, Gemini, and GitHub Copilot-backed setups are the main built-in paths for embeddings without introducing another billing surface.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      dispatch({ type: "SET_TAB", tab: "models" });
                    }}
                    className="rounded-md border border-amber-600/30 bg-white/50 px-2 py-1 text-[11px] font-medium text-amber-900 dark:bg-black/10 dark:text-amber-100"
                  >
                    Open Models
                  </button>
                </div>
              </div>
            )}
            <Select
              value={modelConfigName}
              onChange={(e) => setModelConfigName(e.target.value)}
            >
              <option value="">
                {defaultModel
                  ? `Default (${defaultModel.name} · ${defaultModel.model_id})${modelSupportsImages(defaultModel.provider, defaultModel.model_id) ? " 📷" : ""}`
                  : "(no default configured)"}
              </option>
              {models.map((m) => {
                // Prefix with a camera glyph when the model is known to
                // accept image inputs — surfaces "this agent can read
                // images from WhatsApp bridges / drag-and-drop" without
                // a separate column. Plain <option> can't hold an SVG.
                const vision = modelSupportsImages(m.provider, m.model_id);
                return (
                  <option key={m.name} value={m.name}>
                    {vision ? "📷 " : ""}{m.name} · {m.provider} / {m.model_id}
                  </option>
                );
              })}
            </Select>
            {selectedModel && (
              <div className="space-y-1">
                <p className="text-[11px] text-fg-faint">
                  Using <span className="text-fg-subtle">{selectedModel.provider}</span> / <span className="font-mono text-fg-muted">{selectedModel.model_id}</span>
                  {!modelSupportsImages(selectedModel.provider, selectedModel.model_id) && (
                    isProviderClassified(selectedModel.provider)
                      ? <span className="ml-1 text-amber-700 dark:text-amber-300">· no image input</span>
                      : <span className="ml-1 text-fg-faint">· capabilities unknown</span>
                  )}
                </p>
                <CapBadges provider={selectedModel.provider} modelId={selectedModel.model_id} />
              </div>
            )}
            {models.length === 0 && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400">No model configs yet — go to the Models panel to add one first.</p>
            )}
          </Section>

          <hr className="border-border" />

          {/* Step 3: Tools */}
          <Section step={3} title="Tools">
            {tools.length === 0 ? (
              <p className="text-xs text-fg-faint">No tools available.</p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-fg-faint">{selectedTools.length} of {tools.length} enabled</span>
                  <button
                    onClick={toggleAllTools}
                    className="text-[11px] text-fg-faint hover:text-fg-muted transition-colors"
                  >
                    {selectedTools.length === tools.length ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <div className="space-y-1.5">
                  {groupedTools.map(({ group, categories }) =>
                    group ? (
                      <ToolGroupBlock
                        key={group}
                        group={group}
                        categories={categories}
                        advancedMode={isFullMode}
                        selected={selectedTools}
                        onToggleTool={toggleTool}
                        onToggleCategory={toggleCategory}
                        onToggleCategoryPermission={toggleCategoryPermission}
                        onToggleGroup={toggleGroup}
                      />
                    ) : (
                      categories.map(([category, catTools]) => (
                        <ToolCategoryBlock
                          key={category}
                          category={category}
                          tools={catTools}
                          advancedMode={isFullMode}
                          selected={selectedTools}
                          onToggleTool={toggleTool}
                          onToggleCategory={toggleCategory}
                          onToggleCategoryPermission={toggleCategoryPermission}
                        />
                      ))
                    ),
                  )}
                </div>
              </>
            )}
          </Section>

          {/* Delegates — only meaningful when delegate_to_agent is enabled. */}
          {(() => {
            const canDelegate = selectedTools.includes("delegate_to_agent");
            if (!canDelegate && delegateTargets.length === 0) return null;
            return (
              <>
                <hr className="border-border" />
                <Section step={4} title="Delegates">
                  <p className="text-[11px] text-fg-faint">
                    Other agents this one may hand subtasks to via <code>delegate_to_agent</code>.
                    {!canDelegate && (
                      <span className="text-amber-700 dark:text-amber-400">
                        {" "}Enable the <code>delegate_to_agent</code> tool above for these to take effect.
                      </span>
                    )}
                  </p>
                  {otherAgents.length === 0 ? (
                    <p className="text-xs text-fg-faint">No other agents to delegate to yet.</p>
                  ) : (
                    <div className="space-y-1">
                      {otherAgents.map((a) => {
                        const checked = delegateTargets.includes(a.id);
                        return (
                          <label
                            key={a.id}
                            className="flex items-start gap-2 p-1.5 rounded hover:bg-surface-3/50 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setDelegateTargets((prev) =>
                                  prev.includes(a.id)
                                    ? prev.filter((x) => x !== a.id)
                                    : [...prev, a.id],
                                )
                              }
                              className="mt-0.5"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-medium text-fg">{a.name}</div>
                              {a.identity && (
                                <div className="text-[11px] text-fg-faint truncate">
                                  {a.identity.split("\n")[0]}
                                </div>
                              )}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </Section>
              </>
            );
          })()}

          <hr className="border-border" />

          {/* Step 4: Advanced */}
          <Section step={4} title="Advanced settings">
            {isFullMode && (
              <>
                <label className="block">
                  <span className="text-xs text-fg-subtle mb-1 block">Harness</span>
                  <Select
                    value={harnessId}
                    onChange={(e) => setHarnessId(e.target.value)}
                  >
                    <option value="">
                      Use global default
                      {(() => {
                        const def = harnesses.find((h) => h.id === defaultHarnessId);
                        return def ? ` (${def.name})` : "";
                      })()}
                    </option>
                    {harnesses.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name}{h.builtin ? " (built-in)" : ""}
                      </option>
                    ))}
                  </Select>
                </label>
                <p className="text-[11px] text-fg-faint">
                  Behavioral scaffolding (output formatting, citation rules, anti-fabrication, self-config) injected into this agent&apos;s system prompt.
                </p>

                <hr className="border-border/60 my-2" />

                <label className="block">
                  <span className="text-xs text-fg-subtle mb-1 block">Anti-hallucination detector</span>
                  <Select
                    value={antiHallucMode}
                    onChange={(e) => setAntiHallucMode(e.target.value as "" | "off" | "regex" | "model")}
                  >
                    <option value="">Inherit global default</option>
                    <option value="off">Off — no detection</option>
                    <option value="regex">Regex — fast, free, brittle</option>
                    <option value="model">Model — LLM classifier (more accurate, +1 call/turn)</option>
                  </Select>
                </label>
                {antiHallucMode === "model" && (
                  <label className="block">
                    <span className="text-xs text-fg-subtle mb-1 block">
                      Classifier model
                      {antiHallucModel === "" && (
                        <span className="ml-1 text-fg-faint">(inherits global)</span>
                      )}
                    </span>
                    <Select
                      value={antiHallucModel}
                      onChange={(e) => setAntiHallucModel(e.target.value)}
                    >
                      <option value="">Inherit global JARELA_HALLUCINATION_DETECTOR_MODEL</option>
                      {models.map((m) => (
                        <option key={m.name} value={m.name}>
                          {m.name} — {m.provider}/{m.model_id}
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
                <p className="text-[11px] text-fg-faint">
                  When set to <em>model</em>, every assistant turn for this agent runs through an LLM classifier that judges whether the agent stalled (narrated future work without invoking a write tool). Pick a fast/cheap config (e.g. Haiku, gpt-4o-mini, gemini-flash). If no model is configured here or globally, falls back to <em>regex</em>.
                </p>

                <hr className="border-border/60 my-2" />

                <label className="flex items-start gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="rounded border-border mt-0.5"
                    checked={requireSourceLinks}
                    onChange={(e) => setRequireSourceLinks(e.target.checked)}
                  />
                  <span className="text-xs text-fg-subtle">
                    Require source links on factual claims
                    <span className="block text-[11px] text-fg-faint mt-0.5 font-normal">
                      The system prompt is augmented with a directive to attach a <code>[source](url-or-path)</code> link to every factual claim, and the assistant turn is post-checked: any cited link that wasn&apos;t actually visited via a tool call in this thread gets a warning badge in the chat. Re-uses the classifier model picked above.
                    </span>
                  </span>
                </label>
                {requireSourceLinks && antiHallucModel.trim() === "" && (
                  <p className="text-[11px] text-warn">
                    Pick a classifier model above (or set <em>Anti-hallucination detector</em> to <em>model</em>) so the citation checker has somewhere to run. Without it, the directive is added to the prompt but no verification happens.
                  </p>
                )}

                <hr className="border-border/60 my-2" />
              </>
            )}

            {/* ADR-0043. Per-agent override of the hot / warm / facts split.
                Bar shows the effective value (override or model fallback);
                "Inherit from model" link clears the override. */}
            {(() => {
              const fallback = {
                hot: selectedModel?.params?.context_tier_proportions?.hot ?? 60,
                warm: selectedModel?.params?.context_tier_proportions?.warm ?? 25,
                facts: selectedModel?.params?.context_tier_proportions?.facts ?? 15,
              };
              const value = tierOverride ?? fallback;
              const isOverriding = tierOverride !== null;
              return (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-fg-subtle">Context tier split</span>
                    {isOverriding ? (
                      <button
                        type="button"
                        onClick={() => setTierOverride(null)}
                        className="text-[11px] text-fg-faint hover:text-accent transition-colors"
                      >
                        Inherit from model
                      </button>
                    ) : (
                      <span className="text-[11px] text-fg-faint italic">
                        {selectedModel ? `inheriting from ${selectedModel.name}` : "using built-in defaults"}
                      </span>
                    )}
                  </div>
                  <TierProportionBar
                    value={value}
                    onChange={(next) => setTierOverride(next)}
                  />
                </div>
              );
            })()}

            <hr className="border-border/60 my-2" />

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                className="rounded border-border"
                checked={adaptivePersonaEnabled}
                onChange={(e) => setAdaptivePersonaEnabled(e.target.checked)}
              />
              <span className="text-xs text-fg-subtle">Enable adaptive personality and emotion mirroring</span>
            </label>

            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">MBTI preset</span>
              <Select
                value={adaptiveMbti}
                onChange={(e) => setAdaptiveMbti(e.target.value as MbtiType)}
                disabled={!adaptivePersonaEnabled}
              >
                {MBTI_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t} - {MBTI_PRESETS[t].label}
                  </option>
                ))}
              </Select>
            </label>

            <p className="text-[11px] text-fg-faint">
              Hidden preset values: strength {mbtiPreset.strength}, empathy {mbtiPreset.empathy}, expressiveness {mbtiPreset.expressiveness}, verbosity {mbtiPreset.verbosity}.
            </p>

            <hr className="border-border/60 my-2" />

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                className="rounded border-border"
                checked={voiceEnabled}
                onChange={(e) => setVoiceEnabled(e.target.checked)}
              />
              <span className="text-xs text-fg-subtle">Enable voice (Gemini TTS + STT)</span>
            </label>
            <p className="text-[11px] text-fg-faint">
              When on, the chat input shows a microphone and assistant replies show a play button.
              Requires the Google integration api_key.
            </p>
            {!readiness.voiceReady && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200 leading-snug">
                <p>
                  Voice is not fully ready at the system level yet.
                </p>
                <p className="mt-1 text-amber-900/90 dark:text-amber-100/90">
                  Compatible setup: a Gemini model plus the existing Google AI integration. Without both, enabling voice would require extra setup.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      dispatch({ type: "SET_TAB", tab: "models" });
                    }}
                    className="rounded-md border border-amber-600/30 bg-white/50 px-2 py-1 text-[11px] font-medium text-amber-900 dark:bg-black/10 dark:text-amber-100"
                  >
                    Open Models
                  </button>
                  {!readiness.hasGoogleIntegration && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        dispatch({ type: "SET_TAB", tab: "connections" });
                      }}
                      className="rounded-md border border-amber-600/30 bg-white/50 px-2 py-1 text-[11px] font-medium text-amber-900 dark:bg-black/10 dark:text-amber-100"
                    >
                      Open Connections
                    </button>
                  )}
                </div>
              </div>
            )}
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">TTS model</span>
              <Select
                value={voiceModel}
                onChange={(e) => setVoiceModel(e.target.value)}
                disabled={!voiceEnabled}
              >
                {GEMINI_TTS_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.id} — {m.label}</option>
                ))}
              </Select>
            </label>
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">Voice</span>
              <Select
                value={voiceName}
                onChange={(e) => setVoiceName(e.target.value)}
                disabled={!voiceEnabled}
              >
                {GEMINI_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </Select>
            </label>
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">Transcription model</span>
              <Select
                value={voiceSttModel}
                onChange={(e) => setVoiceSttModel(e.target.value)}
                disabled={!voiceEnabled}
              >
                {GEMINI_STT_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.id} — {m.label}</option>
                ))}
              </Select>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                className="rounded border-border"
                checked={voiceAutoSpeak}
                onChange={(e) => setVoiceAutoSpeak(e.target.checked)}
                disabled={!voiceEnabled}
              />
              <span className="text-xs text-fg-subtle">Auto-speak reply when I send a voice message</span>
            </label>
          </Section>

          {error && <p className="text-red-700 dark:text-red-400 text-xs">{error}</p>}
        </div>

        <div className="flex items-center justify-between px-4 pb-4">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                className="rounded border-border"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
              />
              <span className="text-xs text-fg-subtle">Set as default agent</span>
            </label>
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-fg-subtle hover:text-fg transition-colors">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 text-sm bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Collapsible parent group wrapping multiple ToolCategoryBlocks. Used today
// for the "Work" header that gathers vendor-native tool categories (Atlassian,
// GitHub) under one collapsible. Header tri-state flips every tool in every
// child category on/off; the per-category blocks remain individually toggleable.
function ToolGroupBlock({
  group,
  categories,
  advancedMode,
  selected,
  onToggleTool,
  onToggleCategory,
  onToggleCategoryPermission,
  onToggleGroup,
}: {
  group: string;
  categories: Array<[string, ToolInfo[]]>;
  advancedMode: boolean;
  selected: string[];
  onToggleTool: (name: string) => void;
  onToggleCategory: (category: string, enable: boolean) => void;
  onToggleCategoryPermission: (category: string, kind: ToolPermissionKind, enable: boolean) => void;
  onToggleGroup: (group: string, enable: boolean) => void;
}) {
  const allTools = categories.flatMap(([, ts]) => ts);
  const selectedInGroup = allTools.filter((t) => selected.includes(t.name)).length;
  const allOn = selectedInGroup === allTools.length;
  const someOn = selectedInGroup > 0 && !allOn;
  // Collapsed by default to keep the editor compact on small / PWA viewports;
  // the header still surfaces the selected/total count.
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (headerRef.current) headerRef.current.indeterminate = someOn;
  }, [someOn]);

  return (
    <ToolSelectionSection
      label={group}
      open={open}
      setOpen={setOpen}
      selectedCount={selectedInGroup}
      totalCount={allTools.length}
      allOn={allOn}
      onToggleAll={(enable) => onToggleGroup(group, enable)}
      headerRef={headerRef}
      bodyClassName="space-y-1.5 px-2 pb-2 pt-0.5 border-t border-border/60"
    >
      {categories.map(([category, catTools]) => (
        <ToolCategoryBlock
          key={category}
          category={category}
          tools={catTools}
          advancedMode={advancedMode}
          selected={selected}
          onToggleTool={onToggleTool}
          onToggleCategory={onToggleCategory}
          onToggleCategoryPermission={onToggleCategoryPermission}
        />
      ))}
    </ToolSelectionSection>
  );
}

// Collapsible per-category block with a tri-state header checkbox. The
// header toggle flips the entire category on/off; individual tool checkboxes
// stay available for fine-grained control. Collapsed by default to keep the
// editor short on mobile / PWA viewports.
function ToolCategoryBlock({
  category,
  tools,
  advancedMode,
  selected,
  onToggleTool,
  onToggleCategory,
  onToggleCategoryPermission,
}: {
  category: string;
  tools: ToolInfo[];
  advancedMode: boolean;
  selected: string[];
  onToggleTool: (name: string) => void;
  onToggleCategory: (category: string, enable: boolean) => void;
  onToggleCategoryPermission: (category: string, kind: ToolPermissionKind, enable: boolean) => void;
}) {
  const selectedInCat = tools.filter((t) => selected.includes(t.name)).length;
  const allOn = selectedInCat === tools.length;
  const someOn = selectedInCat > 0 && !allOn;
  // Collapsed by default — see ToolGroupBlock comment.
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLInputElement>(null);

  // Render the tri-state indeterminate dash via the DOM property (React
  // doesn't expose it as a JSX attribute).
  useEffect(() => {
    if (headerRef.current) headerRef.current.indeterminate = someOn;
  }, [someOn]);

  return (
    <ToolSelectionSection
      label={category}
      open={open}
      setOpen={setOpen}
      selectedCount={selectedInCat}
      totalCount={tools.length}
      allOn={allOn}
      onToggleAll={(enable) => onToggleCategory(category, enable)}
      headerRef={headerRef}
      bodyClassName="grid grid-cols-1 sm:grid-cols-2 gap-1.5 px-3 pb-2 pt-0.5 border-t border-border/60"
    >
      {advancedMode ? (
        tools.map((t) => (
          <label
            key={t.name}
            className={`flex items-center gap-2 cursor-pointer rounded-lg border px-2 py-1.5 transition-colors ${
              selected.includes(t.name)
                ? "border-accent/40 bg-accent/10"
                : "border-border bg-surface-2/80 hover:bg-surface-3/70"
            }`}
            title={t.description}
          >
            <input
              type="checkbox"
              className="rounded border-border"
              checked={selected.includes(t.name)}
              onChange={() => onToggleTool(t.name)}
            />
            <span className="min-w-0 flex-1 flex items-center gap-1.5">
              <span className="font-mono text-[11px] text-fg-muted truncate">{t.name}</span>
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] border ${toolScoreClass(t.stats?.score ?? 1)}`}>
                {Math.round((t.stats?.score ?? 1) * 100)}%
              </span>
            </span>
          </label>
        ))
      ) : (
        <NormalPermissionControls
          category={category}
          tools={tools}
          selected={selected}
          onToggle={(kind, enable) => onToggleCategoryPermission(category, kind, enable)}
        />
      )}
    </ToolSelectionSection>
  );
}

function NormalPermissionControls({
  category,
  tools,
  selected,
  onToggle,
}: {
  category: string;
  tools: ToolInfo[];
  selected: string[];
  onToggle: (kind: ToolPermissionKind, enable: boolean) => void;
}) {
  const kinds: ToolPermissionKind[] = ["read", "write", "execute"];
  return (
    <div className="col-span-2 rounded-lg border border-border bg-surface-2/40 p-2.5 space-y-2.5">
      <p className="text-[11px] text-fg-faint leading-snug">
        Quick permissions for {category}. Advanced mode exposes individual functions.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {kinds.map((kind) => {
          const names = tools
            .filter((t) => permissionKindForTool(t.name, category) === kind)
            .map((t) => t.name);
          const selectedCount = names.filter((n) => selected.includes(n)).length;
          const checked = names.length > 0 && selectedCount === names.length;
          return (
            <label key={kind} className={`flex items-center gap-2 cursor-pointer rounded-xl border px-2.5 py-2 transition-colors ${
              checked
                ? "border-accent/50 bg-accent/10"
                : "border-border bg-surface-2 hover:bg-surface-3/70"
            }`}>
              <input
                type="checkbox"
                className="rounded border-border"
                checked={checked}
                disabled={names.length === 0}
                onChange={(e) => onToggle(kind, e.target.checked)}
              />
              <span className="text-[11px] text-fg-subtle capitalize leading-tight">
                <span className="font-medium">{kind}</span>{" "}
                <span className="text-fg-faint">{selectedCount}/{names.length}</span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function ToolSelectionSection({
  label,
  open,
  setOpen,
  selectedCount,
  totalCount,
  allOn,
  onToggleAll,
  headerRef,
  bodyClassName,
  children,
}: {
  label: string;
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  selectedCount: number;
  totalCount: number;
  allOn: boolean;
  onToggleAll: (enable: boolean) => void;
  headerRef: React.RefObject<HTMLInputElement | null>;
  bodyClassName: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface-1/40 overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-2 bg-surface-2/50">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-fg-subtle hover:text-fg transition-colors"
          aria-label={open ? "Collapse" : "Expand"}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <label className="flex items-center gap-1.5 cursor-pointer flex-1 min-w-0">
          <input
            ref={headerRef}
            type="checkbox"
            className="rounded border-border"
            checked={allOn}
            onChange={(e) => onToggleAll(e.target.checked)}
          />
          <span className="text-[12px] font-semibold text-fg truncate">{label}</span>
        </label>
        <span className="text-[10px] text-fg-faint shrink-0">{selectedCount}/{totalCount}</span>
      </div>
      {open && <div className={bodyClassName}>{children}</div>}
    </div>
  );
}

function toolScoreClass(score: number): string {
  if (score >= 0.75) {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (score >= 0.5) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300";
}
