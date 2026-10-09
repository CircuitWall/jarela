"use client";
import { ArrowUpRight, Cpu, Plus, Star, Trash2 } from "lucide-react";
import { HeaderAction, PanelHeader } from "@/components/ui/PanelHeader";
import { useEffect, useRef, useState } from "react";
import type { ModelConfig } from "@/api/types";
import { refreshRuntimeConfig } from "@/api/runtime-config";
import { Select } from "@/components/ui/Select";
import { useModels } from "@/hooks/useModels";
import { useAgents } from "@/hooks/useAgents";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";
import { buildHref } from "@/lib/ui/navigate";
import { ModelEditor } from "./ModelEditor";
import { ProviderLogo } from "./ProviderLogo";
import { CapBadges } from "./CapBadges";
import { CustomProvidersSection } from "./CustomProvidersSection";
import { EmbeddingModelSection } from "./EmbeddingModelSection";
import { SettingsCard, SettingsGroup } from "@/components/ui/SettingsCard";
import { errorMessage } from "@/lib/utils/error";
import type { UsageStrategy } from "@/lib/agents/usage-strategy";

import { PanelMessage } from "@/components/ui/PanelMessage";
import { confirmAction } from "@/lib/ui/confirm";

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "bg-orange-900/40 text-orange-700 dark:text-orange-300 border-orange-700",
  openai: "bg-green-900/40 text-green-700 dark:text-green-300 border-green-700",
  "github-copilot": "bg-purple-900/40 text-purple-300 border-purple-700",
};

type RouterMode = "off" | "heuristic";
type RouterPolicy = "cheap" | "fast" | "balanced" | "quality";
type GlobalStrategy = "cost_saving" | "fast" | "balanced" | "high_reasoning";

interface EnvEntry {
  name: string;
  current: string;
}

export function ModelsPanel() {
  const { models, assignments, loading, create, update, remove, refresh } = useModels();
  const { agents, loading: agentsLoading } = useAgents();
  const strategyOverrides = agents.filter((agent) => agent.usage_strategy != null);
  const [editing, setEditing] = useState<ModelConfig | null | "new">(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [routerMode, setRouterMode] = useState<RouterMode>("off");
  const [routerPolicy, setRouterPolicy] = useState<RouterPolicy>("balanced");
  const [usageStrategy, setUsageStrategy] = useState<UsageStrategy>("balanced");
  const [routerLoading, setRouterLoading] = useState(true);
  const [routerSaving, setRouterSaving] = useState<null | "mode" | "policy" | "strategy">(null);
  const [routerError, setRouterError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useDeepLinkScroll("models", "model", containerRef);
  const globalStrategy: GlobalStrategy = usageStrategy === "cost_saving"
    ? "cost_saving"
    : usageStrategy === "fast"
      ? "fast"
      : usageStrategy === "high_reasoning"
      ? "high_reasoning"
      : routerPolicy === "fast"
        ? "fast"
        : routerPolicy === "cheap"
          ? "cost_saving"
          : routerPolicy === "quality"
            ? "high_reasoning"
            : "balanced";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/v1/env", { cache: "no-store" });
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const body = (await r.json()) as { entries: EnvEntry[] };
        const mode = body.entries.find((e) => e.name === "JARELA_MODEL_ROUTER_MODE")?.current;
        const policy = body.entries.find((e) => e.name === "JARELA_MODEL_ROUTER_POLICY")?.current;
        const strategy = body.entries.find((e) => e.name === "JARELA_USAGE_STRATEGY")?.current;
        if (!cancelled) {
          setRouterMode(mode === "heuristic" ? "heuristic" : "off");
          setRouterPolicy(
            policy === "cheap" || policy === "fast" || policy === "quality" ? policy : "balanced",
          );
          setUsageStrategy(
            strategy === "cost_saving" || strategy === "fast" || strategy === "high_reasoning" ? strategy : "balanced",
          );
          setRouterError(null);
        }
      } catch (e) {
        if (!cancelled) setRouterError(errorMessage(e));
      } finally {
        if (!cancelled) setRouterLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleSave(name: string, data: Omit<ModelConfig, "name" | "created_at" | "updated_at">) {
    if (editing === "new") await create(name, data);
    else if (editing) await update(name, data);
    refresh();
  }

  async function handleSetDefault(m: ModelConfig) {
    await update(m.name, { provider: m.provider, model_id: m.model_id, params: m.params, is_default: true });
  }

  async function handleRemove(name: string) {
    const affectedAgents = assignments
      .filter((assignment) => assignment.model_config_name === name)
      .map((assignment) => agents.find((agent) => agent.id === assignment.agent_id)?.name ?? assignment.agent_id);
    if (affectedAgents.length > 0) {
      const warning = `${affectedAgents.join(", ")} will use automatic model selection after deletion.`;
      if (!(await confirmAction({ message: `Delete model config "${name}"?\n\n${warning}`, destructive: true }))) return;
    }

    setDeleteError(null);
    try {
      await remove(name);
    } catch (e) {
      setDeleteError(`Could not delete "${name}": ${errorMessage(e)}`);
    }
  }

  async function persistRouterSetting(name: string, value: string, field: "mode" | "policy" | "strategy") {
    setRouterSaving(field);
    setRouterError(null);
    try {
      const r = await fetch("/api/v1/env", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, value }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${r.status} ${r.statusText}`);
      }
      refreshRuntimeConfig();
    } catch (e) {
      setRouterError(errorMessage(e));
      throw e;
    } finally {
      setRouterSaving(null);
    }
  }

  async function handleRouterModeChange(next: RouterMode) {
    const prev = routerMode;
    setRouterMode(next);
    try {
      await persistRouterSetting("JARELA_MODEL_ROUTER_MODE", next, "mode");
    } catch {
      setRouterMode(prev);
    }
  }

  async function handleGlobalStrategyChange(next: GlobalStrategy) {
    const previousUsageStrategy = usageStrategy;
    const previousRouterPolicy = routerPolicy;
    const nextUsageStrategy: UsageStrategy = next === "cost_saving" || next === "fast" || next === "high_reasoning"
      ? next
      : "balanced";
    const nextRouterPolicy: RouterPolicy = next === "cost_saving"
      ? "cheap"
      : next === "high_reasoning"
        ? "quality"
        : next;
    setUsageStrategy(nextUsageStrategy);
    setRouterPolicy(nextRouterPolicy);
    try {
      setRouterSaving("strategy");
      setRouterError(null);
      const response = await fetch("/api/v1/env", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          updates: [
            { name: "JARELA_USAGE_STRATEGY", value: nextUsageStrategy },
            { name: "JARELA_MODEL_ROUTER_POLICY", value: nextRouterPolicy },
          ],
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `${response.status} ${response.statusText}`);
      }
      refreshRuntimeConfig();
    } catch (error) {
      setUsageStrategy(previousUsageStrategy);
      setRouterPolicy(previousRouterPolicy);
      setRouterError(errorMessage(error));
    } finally {
      setRouterSaving(null);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <PanelHeader icon={<Cpu size={14} />} title="Models">
        <HeaderAction icon={<Plus size={14} />} label="New" onClick={() => setEditing("new")} />
      </PanelHeader>

      <div ref={containerRef} className="flex-1 overflow-y-auto no-scrollbar">
        <div className="px-4 pt-3">
          <SettingsGroup>
          <SettingsCard
            id="routing"
            title="Routing"
            description="Control how Jarela chooses the execution model for each turn. Automatic routing uses task complexity, tools, attachments, recent failures, latency, cache affinity, and cost policy."
          >
            <label className="block space-y-1">
              <span className="text-[11px] text-fg-faint">Global model strategy</span>
              <Select
                value={globalStrategy}
                disabled={routerLoading || routerSaving !== null}
                onChange={(e) => { void handleGlobalStrategyChange(e.target.value as GlobalStrategy); }}
              >
                <option value="cost_saving">Economical</option>
                <option value="fast">Fast</option>
                <option value="balanced">Balanced</option>
                <option value="high_reasoning">High reasoning</option>
              </Select>
            </label>
            <p className="text-[11px] text-fg-faint">
              Each strategy sets model selection and usage behavior together. Economical favors lower-cost models, smaller context/output budgets, reduced thinking, fewer retries, and concise replies. Per-agent strategy overrides take precedence.
            </p>
            <p className="text-[11px] text-fg-faint">
              High reasoning automatically recalls saved facts and prior chats. Other strategies rely on explicit agent searches when that context is needed.
            </p>
            <div className="border-t border-border/60 pt-2">
              <p className="text-[11px] text-fg-subtle font-medium mb-1">
                Agent strategy overrides ({strategyOverrides.length})
              </p>
              {agentsLoading && agents.length === 0 ? (
                <p className="text-[11px] text-fg-faint">Loading agents…</p>
              ) : strategyOverrides.length === 0 ? (
                <p className="text-[11px] text-fg-faint">All agents inherit the global strategy.</p>
              ) : (
                <ul className="max-h-28 overflow-y-auto space-y-0.5">
                  {strategyOverrides.map((agent) => (
                    <li key={agent.id}>
                      <a
                        href={buildHref("agents", agent.id)}
                        className="flex items-center gap-1.5 py-0.5 text-[11px] text-accent hover:text-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      >
                        <span className="truncate">{agent.name}</span>
                        <span className="text-fg-faint">· {agent.usage_strategy?.replace("_", " ")}</span>
                        <ArrowUpRight size={11} className="ml-auto shrink-0" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <label className="block space-y-1">
                <span className="text-[11px] text-fg-faint">Balanced strategy router mode</span>
                <Select
                  value={routerMode}
                  disabled={routerLoading || routerSaving !== null || globalStrategy !== "balanced"}
                  onChange={(e) => { void handleRouterModeChange(e.target.value as RouterMode); }}
                >
                  <option value="off">Off</option>
                  <option value="heuristic">Automatic routing</option>
                </Select>
              </label>
            </div>
            <p className="text-[11px] text-fg-faint">
              Economical, Fast, and High reasoning route automatically. This switch applies only to Balanced. Explicit per-agent model overrides still win; the starred model remains the fallback.
            </p>
            {routerSaving && <p className="text-[11px] text-fg-faint">Saving router settings…</p>}
            {routerError && <p className="text-[11px] text-red-700 dark:text-red-400">{routerError}</p>}
          </SettingsCard>
          <EmbeddingModelSection models={models} />
          </SettingsGroup>
        </div>

        {/* Model list */}
        <div className="px-4 py-2">
          {loading && models.length === 0 && <PanelMessage>Loading…</PanelMessage>}
          {!loading && models.length === 0 && <PanelMessage>No model configs yet</PanelMessage>}
          {deleteError && (
            <p className="text-red-700 dark:text-red-400 text-xs mb-2 px-1">{deleteError}</p>
          )}
          {models.map((m) => {
            const inUse = assignments.some((a) => a.model_config_name === m.name);
            return (
            <div key={m.name} data-deep-link-id={m.name} onClick={() => setEditing(m)} className="flex items-center gap-3 py-2.5 border-b border-border/60 group cursor-pointer hover:bg-surface-3/30 transition-colors">
              <span className="shrink-0 text-fg-subtle">
                <ProviderLogo name={m.provider} size={22} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium text-fg">{m.name}</span>
                  {m.is_default && <Star size={11} className="text-yellow-700 dark:text-yellow-400 fill-yellow-400 shrink-0" />}
                  <span className={`text-xs px-1.5 py-0.5 rounded border ${PROVIDER_COLORS[m.provider] ?? "bg-surface-2 text-fg-muted border-border"}`}>
                    {m.provider}
                  </span>
                </div>
                <p className="text-xs text-fg-subtle truncate">{m.model_id}</p>
                <div className="mt-1">
                  <CapBadges provider={m.provider} modelId={m.model_id} />
                </div>
              </div>
              <div className="flex gap-1 opacity-40 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity shrink-0">
                {!m.is_default && (
                  <button onClick={(e) => { e.stopPropagation(); handleSetDefault(m); }} className="p-1 text-fg-subtle hover:text-yellow-700 dark:hover:text-yellow-400 transition-colors" title="Set as default">
                    <Star size={13} />
                  </button>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); handleRemove(m.name); }}
                  className="p-1 text-fg-subtle hover:text-red-700 dark:hover:text-red-400 transition-colors"
                  title={inUse ? "Delete; assigned agents will use automatic model selection" : "Delete"}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
            );
          })}
        </div>

        <CustomProvidersSection />

      </div>

      {editing !== null && (
        <ModelEditor
          model={editing === "new" ? undefined : editing}
          onSave={handleSave}
          onClose={() => { setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}
