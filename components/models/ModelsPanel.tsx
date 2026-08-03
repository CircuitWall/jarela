"use client";
import { Cpu, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ModelConfig } from "@/api/types";
import { refreshRuntimeConfig } from "@/api/runtime-config";
import { Select } from "@/components/ui/Select";
import { useModels } from "@/hooks/useModels";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";
import { ModelEditor } from "./ModelEditor";
import { ProviderLogo } from "./ProviderLogo";
import { CapBadges } from "./CapBadges";
import { CustomProvidersSection } from "./CustomProvidersSection";
import { errorMessage } from "@/lib/utils/error";

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "bg-orange-900/40 text-orange-700 dark:text-orange-300 border-orange-700",
  openai: "bg-green-900/40 text-green-700 dark:text-green-300 border-green-700",
  "github-copilot": "bg-purple-900/40 text-purple-300 border-purple-700",
};

type RouterMode = "off" | "heuristic";
type RouterPolicy = "cheap" | "fast" | "balanced" | "quality";

interface EnvEntry {
  name: string;
  current: string;
}

export function ModelsPanel() {
  const { models, assignments, loading, create, update, remove, refresh } = useModels();
  const [editing, setEditing] = useState<ModelConfig | null | "new">(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [routerMode, setRouterMode] = useState<RouterMode>("off");
  const [routerPolicy, setRouterPolicy] = useState<RouterPolicy>("balanced");
  const [routerLoading, setRouterLoading] = useState(true);
  const [routerSaving, setRouterSaving] = useState<null | "mode" | "policy">(null);
  const [routerError, setRouterError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useDeepLinkScroll("models", "model", containerRef);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/v1/env", { cache: "no-store" });
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const body = (await r.json()) as { entries: EnvEntry[] };
        const mode = body.entries.find((e) => e.name === "JARELA_MODEL_ROUTER_MODE")?.current;
        const policy = body.entries.find((e) => e.name === "JARELA_MODEL_ROUTER_POLICY")?.current;
        if (!cancelled) {
          setRouterMode(mode === "heuristic" ? "heuristic" : "off");
          setRouterPolicy(
            policy === "cheap" || policy === "fast" || policy === "quality" ? policy : "balanced",
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
    setDeleteError(null);
    try {
      await remove(name);
    } catch (e) {
      setDeleteError(`Could not delete "${name}": ${errorMessage(e)}`);
    }
  }

  async function persistRouterSetting(name: string, value: string, field: "mode" | "policy") {
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

  async function handleRouterPolicyChange(next: RouterPolicy) {
    const prev = routerPolicy;
    setRouterPolicy(next);
    try {
      await persistRouterSetting("JARELA_MODEL_ROUTER_POLICY", next, "policy");
    } catch {
      setRouterPolicy(prev);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <Cpu size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg mr-auto">Model Configs</h2>
        <button onClick={() => setEditing("new")} className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors">
          <Plus size={14} /> New
        </button>
      </div>

      <div ref={containerRef} className="flex-1 overflow-y-auto no-scrollbar">
        <div className="px-4 pt-3">
          <div className="rounded-lg border border-border bg-surface-2/60 px-3 py-3 space-y-3">
            <div>
              <h3 className="text-xs font-semibold text-fg">Routing</h3>
              <p className="text-[11px] text-fg-subtle mt-1 leading-snug">
                Control how Jarela chooses the execution model for each turn. Automatic routing uses task complexity, tools, attachments, recent failures, latency, cache affinity, and cost policy.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-[11px] text-fg-faint">Router mode</span>
                <Select
                  value={routerMode}
                  disabled={routerLoading || routerSaving !== null}
                  onChange={(e) => { void handleRouterModeChange(e.target.value as RouterMode); }}
                >
                  <option value="off">Off</option>
                  <option value="heuristic">Automatic routing</option>
                </Select>
              </label>
              <label className="space-y-1">
                <span className="text-[11px] text-fg-faint">Routing policy</span>
                <Select
                  value={routerPolicy}
                  disabled={routerLoading || routerSaving !== null}
                  onChange={(e) => { void handleRouterPolicyChange(e.target.value as RouterPolicy); }}
                >
                  <option value="cheap">Cheap</option>
                  <option value="fast">Fast</option>
                  <option value="balanced">Balanced</option>
                  <option value="quality">Quality</option>
                </Select>
              </label>
            </div>
            <p className="text-[11px] text-fg-faint">
              Explicit per-agent model overrides still win. The starred model below remains the fallback when no explicit or routed choice is available.
            </p>
            {routerSaving && <p className="text-[11px] text-fg-faint">Saving router settings…</p>}
            {routerError && <p className="text-[11px] text-red-700 dark:text-red-400">{routerError}</p>}
          </div>
        </div>

        {/* Model list */}
        <div className="px-4 py-2">
          {loading && models.length === 0 && <p className="text-fg-faint text-sm py-6 text-center">Loading…</p>}
          {!loading && models.length === 0 && <p className="text-fg-faint text-sm py-6 text-center">No model configs yet</p>}
          {deleteError && (
            <p className="text-red-700 dark:text-red-400 text-xs mb-2 px-1">{deleteError}</p>
          )}
          {models.map((m) => {
            const inUse = assignments.some((a) => a.model_config_name === m.name);
            return (
            <div key={m.name} data-deep-link-id={m.name} className="flex items-center gap-3 py-2.5 border-b border-border/60 group">
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
                  <button onClick={() => handleSetDefault(m)} className="p-1 text-fg-subtle hover:text-yellow-700 dark:hover:text-yellow-400 transition-colors" title="Set as default">
                    <Star size={13} />
                  </button>
                )}
                <button onClick={() => setEditing(m)} className="p-1 text-fg-subtle hover:text-fg transition-colors" title="Edit">
                  <Pencil size={13} />
                </button>
                <button
                  onClick={() => handleRemove(m.name)}
                  disabled={inUse}
                  className="p-1 text-fg-subtle hover:text-red-700 dark:hover:text-red-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={inUse ? "Unassign from agents first" : "Delete"}
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
