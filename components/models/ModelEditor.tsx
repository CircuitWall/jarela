"use client";
import { BookOpen, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { CatalogModel, ModelConfig } from "@/api/types";
import { useAppContext } from "@/contexts/AppContext";
import { pushErrorToast } from "@/lib/ui/error-report";
import { CapBadges } from "./CapBadges";

const FALLBACK_PROVIDERS = ["anthropic", "openai", "github-copilot", "deepseek", "gemini", "langchain"];

const CATALOG_PROVIDERS = new Set<string>(["openai", "github-copilot", "anthropic", "gemini", "deepseek"]);
const DEFAULT_CONTEXT_WINDOW = 8192;
const DEFAULT_TIER_PROPORTIONS = { hot: 60, warm: 25, facts: 15 };

type Tier = "hot" | "warm" | "facts";

function sanitizeTierPriority(
  value: ModelConfig["params"]["context_tier_priority"] | undefined,
): [Tier, Tier, Tier] {
  if (!Array.isArray(value) || value.length !== 3) return ["hot", "warm", "facts"];
  const filtered = value.filter((v): v is Tier => v === "hot" || v === "warm" || v === "facts");
  if (filtered.length !== 3 || new Set(filtered).size !== 3) return ["hot", "warm", "facts"];
  return [filtered[0], filtered[1], filtered[2]];
}

function toNumberOrEmpty(v: string): number | undefined {
  if (!v.trim()) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function fmtInt(n: number): string {
  return n.toLocaleString();
}

interface Props {
  model?: ModelConfig;
  onSave: (name: string, data: Omit<ModelConfig, "name" | "created_at" | "updated_at">) => Promise<void>;
  onClose: () => void;
}

function fmtCtx(n: number | null) {
  if (!n) return null;
  return n >= 1000000 ? `${n / 1000000}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export function ModelEditor({ model, onSave, onClose }: Props) {
  const { state } = useAppContext();
  const isAdvanced = state.experienceMode === "advanced";
  const isEdit = !!model;
  const [name, setName] = useState(model?.name ?? "");
  const [provider, setProvider] = useState(model?.provider ?? "anthropic");
  const [providers, setProviders] = useState<string[]>(FALLBACK_PROVIDERS);
  const [modelId, setModelId] = useState(model?.model_id ?? "");
  const [apiKey, setApiKey] = useState(model?.params.api_key ?? "");
  const [baseUrl, setBaseUrl] = useState(model?.params.base_url ?? "");

  const [extraHeaders, setExtraHeaders] = useState(
    model?.params.extra_headers ? JSON.stringify(model.params.extra_headers, null, 2) : ""
  );
  const [temperature, setTemperature] = useState(String(model?.params.temperature ?? ""));
  const [maxTokens, setMaxTokens] = useState(String(model?.params.max_tokens ?? ""));
  const [contextWindowTokens, setContextWindowTokens] = useState(String(model?.params.context_window_tokens ?? ""));
  const [hotRatio, setHotRatio] = useState(String(Math.round((model?.params.context_tier_proportions?.hot ?? (DEFAULT_TIER_PROPORTIONS.hot / 100)) * 100)));
  const [warmRatio, setWarmRatio] = useState(String(Math.round((model?.params.context_tier_proportions?.warm ?? (DEFAULT_TIER_PROPORTIONS.warm / 100)) * 100)));
  const [factsRatio, setFactsRatio] = useState(String(Math.round((model?.params.context_tier_proportions?.facts ?? (DEFAULT_TIER_PROPORTIONS.facts / 100)) * 100)));
  const [tierPriority, setTierPriority] = useState<[Tier, Tier, Tier]>(sanitizeTierPriority(model?.params.context_tier_priority));
  const [isDefault, setIsDefault] = useState(model?.is_default ?? false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Catalog state
  const [showCatalog, setShowCatalog] = useState(false);
  const [catalog, setCatalog] = useState<CatalogModel[] | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogSearch, setCatalogSearch] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let mounted = true;
    api.models.providers()
      .then((names) => {
        if (!mounted || !Array.isArray(names) || names.length === 0) return;
        setProviders(names);
      })
      .catch(() => {
        // Keep fallback provider list if endpoint fails.
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Reset catalog when provider changes
  useEffect(() => {
    setCatalog(null);
    setCatalogError(null);
    setShowCatalog(false);
  }, [provider]);

  async function loadCatalog() {
    if (!CATALOG_PROVIDERS.has(provider)) return;
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const models = await api.models.catalog(provider);
      setCatalog(models);
      setShowCatalog(true);
    } catch (e) {
      // Inline catalog error preserves the in-context retry path; toast
      // surfaces the report-issue affordance.
      setCatalogError(String(e));
      pushErrorToast({
        title: "Couldn't load model catalog",
        error: e,
        context: { panel: "models", action: "catalog.load", provider },
      });
    } finally {
      setCatalogLoading(false);
    }
  }

  async function handleSave() {
    setError(null);
    if (!name.trim() || !modelId.trim()) { setError("Name and model ID are required"); return; }
    let parsed_headers: Record<string, string> | undefined;
    if (extraHeaders.trim()) {
      try { parsed_headers = JSON.parse(extraHeaders); }
      catch { setError("Extra headers must be valid JSON"); return; }
    }
    setSaving(true);
    try {
      const params: ModelConfig["params"] = {};
      const parsedWindow = toNumberOrEmpty(contextWindowTokens);
      const parsedHot = toNumberOrEmpty(hotRatio);
      const parsedWarm = toNumberOrEmpty(warmRatio);
      const parsedFacts = toNumberOrEmpty(factsRatio);
      const tiers = [parsedHot ?? 0, parsedWarm ?? 0, parsedFacts ?? 0];
      if (tiers.some((n) => n < 0)) {
        setError("Tier proportions cannot be negative");
        setSaving(false);
        return;
      }
      const tierSum = tiers[0] + tiers[1] + tiers[2];
      if (tierSum <= 0) {
        setError("Tier proportions must add up to more than 0");
        setSaving(false);
        return;
      }
      if (new Set(tierPriority).size !== 3) {
        setError("Tier priority must list hot, warm, and facts exactly once");
        setSaving(false);
        return;
      }

      if (apiKey) params.api_key = apiKey;
      if (baseUrl) params.base_url = baseUrl;
      if (parsed_headers) params.extra_headers = parsed_headers;
      if (temperature) params.temperature = Number(temperature);
      if (maxTokens) params.max_tokens = Number(maxTokens);
      if (parsedWindow && parsedWindow > 0) params.context_window_tokens = Math.floor(parsedWindow);
      params.context_tier_proportions = {
        hot: (parsedHot ?? 0) / tierSum,
        warm: (parsedWarm ?? 0) / tierSum,
        facts: (parsedFacts ?? 0) / tierSum,
      };
      params.context_tier_priority = tierPriority;
      await onSave(name.trim(), { provider, model_id: modelId.trim(), params, is_default: isDefault });
      onClose();
    } catch (e) {
      pushErrorToast({
        title: "Couldn't save model",
        error: e,
        context: { panel: "models", action: "model.save", name: name.trim(), provider, model_id: modelId.trim() },
      });
    }
    finally { setSaving(false); }
  }

  const showGitHub = provider === "github-copilot";

  const contextWindow = Math.max(1, Math.floor(toNumberOrEmpty(contextWindowTokens) ?? DEFAULT_CONTEXT_WINDOW));
  const outputReserve = Math.max(256, Math.min(contextWindow - 1, Math.floor(toNumberOrEmpty(maxTokens) ?? contextWindow * 0.2)));
  const inputBudget = Math.max(0, contextWindow - outputReserve - Math.min(1200, contextWindow - outputReserve));
  const hotP = Math.max(0, toNumberOrEmpty(hotRatio) ?? DEFAULT_TIER_PROPORTIONS.hot);
  const warmP = Math.max(0, toNumberOrEmpty(warmRatio) ?? DEFAULT_TIER_PROPORTIONS.warm);
  const factsP = Math.max(0, toNumberOrEmpty(factsRatio) ?? DEFAULT_TIER_PROPORTIONS.facts);
  const totalP = hotP + warmP + factsP || 1;
  const hotBudget = Math.floor(inputBudget * (hotP / totalP));
  const warmBudget = Math.floor(inputBudget * (warmP / totalP));
  const factsBudget = Math.max(0, inputBudget - hotBudget - warmBudget);

  function updatePriority(index: 0 | 1 | 2, value: Tier) {
    setTierPriority((prev) => {
      const next: [Tier, Tier, Tier] = [...prev] as [Tier, Tier, Tier];
      const existing = next.indexOf(value);
      if (existing !== -1 && existing !== index) {
        next[existing] = next[index];
      }
      next[index] = value;
      return next;
    });
  }

  const filteredCatalog = catalog?.filter((m) =>
    !catalogSearch || m.id.toLowerCase().includes(catalogSearch.toLowerCase())
  ) ?? [];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 p-2 sm:p-4 overflow-y-auto">
      <div className={`bg-surface-2 border border-border rounded-2xl w-full shadow-xl my-2 sm:my-4 ${isAdvanced ? "max-w-2xl" : "max-w-xl"}`}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-fg">{isEdit ? "Edit model config" : "New model config"}</h3>
          <button onClick={onClose} className="text-fg-subtle hover:text-fg transition-colors"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-3.5">
          {!isAdvanced && (
            <div className="rounded-xl border border-border bg-surface-3/60 px-3 py-2.5">
              <p className="text-[11px] text-fg-faint leading-snug">
                Normal mode is active. Core model settings are shown here; advanced context tuning and low-level overrides are hidden.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">Config name</span>
              <input className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. work-claude" disabled={isEdit} />
            </label>
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">Provider</span>
              <select className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                value={provider} onChange={(e) => setProvider(e.target.value)}>
                {providers.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          </div>

          {/* Model ID + catalog browse */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-fg-subtle">Model ID</span>
              {CATALOG_PROVIDERS.has(provider) && (
                <button
                  onClick={() => showCatalog ? setShowCatalog(false) : loadCatalog()}
                  disabled={catalogLoading}
                  className="flex items-center gap-1 text-[11px] text-accent hover:text-accent/80 transition-colors disabled:opacity-50"
                >
                  <BookOpen size={11} />
                  {catalogLoading ? "Loading…" : showCatalog ? "Hide catalog" : "Browse catalog"}
                </button>
              )}
            </div>
            <input
              className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="e.g. claude-sonnet-4-6"
            />
            {catalogError && <p className="text-red-700 dark:text-red-400 text-xs">{catalogError}</p>}

            {/* Catalog panel */}
            {showCatalog && catalog && (
              <div className="border border-border rounded-xl overflow-hidden bg-surface-3 shadow-sm">
                <div className="px-2 py-1.5 border-b border-border bg-surface-2/50">
                  <input
                    className="w-full bg-surface text-fg text-xs rounded px-2 py-1 border border-border focus:outline-none focus:ring-1 focus:ring-accent placeholder-fg-faint"
                    placeholder="Filter models…"
                    value={catalogSearch}
                    onChange={(e) => setCatalogSearch(e.target.value)}
                  />
                </div>
                <div className="max-h-52 overflow-y-auto divide-y divide-border">
                  {filteredCatalog.length === 0 && (
                    <p className="text-xs text-fg-faint text-center py-3">No models match</p>
                  )}
                  {filteredCatalog.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => { setModelId(m.id); setShowCatalog(false); }}
                      className={`w-full text-left px-3 py-2 hover:bg-surface-2 transition-colors ${m.id === modelId ? "bg-accent/10 border-l-2 border-accent" : ""}`}
                    >
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-xs font-mono text-fg truncate">{m.id}</span>
                        {m.context_length && (
                          <span className="text-[10px] text-fg-faint shrink-0">{fmtCtx(m.context_length)} ctx</span>
                        )}
                        {m.hosted_on && (
                          <span className="text-[10px] text-fg-faint shrink-0 truncate">{m.hosted_on}</span>
                        )}
                      </div>
                      <CapBadges caps={m.capabilities} />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>



          {showGitHub && <GitHubCopilotAuth />}

          <label className="block">
            <span className="text-xs text-fg-subtle mb-1 block">API Key</span>
            <input type="password" className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
              value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="••••••••" />
          </label>

          {isAdvanced && (
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">Base URL (optional override)</span>
              <input className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://custom-endpoint" />
            </label>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">Temperature</span>
              <input type="number" min="0" max="2" step="0.1" className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                value={temperature} onChange={(e) => setTemperature(e.target.value)} placeholder="0.7" />
            </label>
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">Max tokens</span>
              <input type="number" className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="4096" />
            </label>
          </div>

          {isAdvanced && (
            <>
              <label className="block">
                <span className="text-xs text-fg-subtle mb-1 block">Context window tokens</span>
                <input type="number" min="1" className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                  value={contextWindowTokens} onChange={(e) => setContextWindowTokens(e.target.value)} placeholder="8192" />
              </label>

              <div className="rounded-xl border border-border bg-surface-3 p-3 space-y-2">
                <p className="text-xs text-fg-subtle">Context tiers and resource usage</p>
                <div className="grid grid-cols-3 gap-2">
                  <label className="block">
                    <span className="text-[11px] text-fg-faint mb-1 block">Hot %</span>
                    <input type="number" min="0" className="w-full bg-surface text-fg text-xs rounded px-2 py-1 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                      value={hotRatio} onChange={(e) => setHotRatio(e.target.value)} />
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-fg-faint mb-1 block">Warm %</span>
                    <input type="number" min="0" className="w-full bg-surface text-fg text-xs rounded px-2 py-1 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                      value={warmRatio} onChange={(e) => setWarmRatio(e.target.value)} />
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-fg-faint mb-1 block">Facts %</span>
                    <input type="number" min="0" className="w-full bg-surface text-fg text-xs rounded px-2 py-1 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                      value={factsRatio} onChange={(e) => setFactsRatio(e.target.value)} />
                  </label>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <label className="block">
                    <span className="text-[11px] text-fg-faint mb-1 block">Priority 1</span>
                    <select className="w-full bg-surface text-fg text-xs rounded px-2 py-1 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                      value={tierPriority[0]} onChange={(e) => updatePriority(0, e.target.value as Tier)}>
                      <option value="hot">hot</option>
                      <option value="warm">warm</option>
                      <option value="facts">facts</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-fg-faint mb-1 block">Priority 2</span>
                    <select className="w-full bg-surface text-fg text-xs rounded px-2 py-1 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                      value={tierPriority[1]} onChange={(e) => updatePriority(1, e.target.value as Tier)}>
                      <option value="hot">hot</option>
                      <option value="warm">warm</option>
                      <option value="facts">facts</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-fg-faint mb-1 block">Priority 3</span>
                    <select className="w-full bg-surface text-fg text-xs rounded px-2 py-1 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                      value={tierPriority[2]} onChange={(e) => updatePriority(2, e.target.value as Tier)}>
                      <option value="hot">hot</option>
                      <option value="warm">warm</option>
                      <option value="facts">facts</option>
                    </select>
                  </label>
                </div>
                <p className="text-[11px] text-fg-faint leading-relaxed">
                  Estimated per-turn allocation: window {fmtInt(contextWindow)} tokens, output reserve {fmtInt(outputReserve)}, input {fmtInt(inputBudget)}.
                  Hot gets about {fmtInt(hotBudget)}, warm {fmtInt(warmBudget)}, facts {fmtInt(factsBudget)} tokens.
                  Higher hot keeps recent messages; higher warm favors recap summaries; higher facts favors durable memory retrieval.
                </p>
              </div>
            </>
          )}

          {isAdvanced && (
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">Extra headers (JSON, optional)</span>
              <textarea className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent font-mono h-20 resize-none"
                value={extraHeaders} onChange={(e) => setExtraHeaders(e.target.value)} placeholder='{"X-Custom": "value"}' />
            </label>
          )}

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="rounded border-border" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            <span className="text-xs text-fg-muted">Set as default model</span>
          </label>

          {error && <p className="text-red-700 dark:text-red-400 text-xs">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-4 pb-4 pt-1 border-t border-border/60">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-fg-subtle hover:text-fg transition-colors">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="px-4 py-1.5 text-sm font-medium bg-accent hover:bg-accent-hover text-white rounded-xl shadow-sm transition-colors disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function GitHubCopilotAuth() {
  const [status, setStatus] = useState<{ signed_in: boolean; stored_at: string | null } | null>(null);
  const [flow, setFlow] = useState<{ user_code: string; verification_uri: string; device_code: string; interval: number } | null>(null);
  const [polling, setPolling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.githubCopilotAuth.status().then(setStatus).catch(() => setStatus({ signed_in: false, stored_at: null }));
  }, []);

  async function startSignIn() {
    setError(null); setMessage(null);
    try {
      const f = await api.githubCopilotAuth.start();
      setFlow({ user_code: f.user_code, verification_uri: f.verification_uri, device_code: f.device_code, interval: f.interval || 5 });
      setPolling(true);
      pollLoop(f.device_code, f.interval || 5, f.expires_in || 900);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function pollLoop(device_code: string, intervalSec: number, expiresInSec: number) {
    const deadline = Date.now() + expiresInSec * 1000;
    let interval = intervalSec;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval * 1000));
      try {
        const res = await api.githubCopilotAuth.poll(device_code);
        if (res.status === "success") {
          setMessage("Signed in to GitHub Copilot.");
          setFlow(null);
          setPolling(false);
          const s = await api.githubCopilotAuth.status();
          setStatus(s);
          return;
        }
        if (res.status === "slow_down") { interval += 5; continue; }
        if (res.status === "pending") continue;
        setError(`Sign-in failed: ${res.status}${res.error ? ` (${res.error})` : ""}`);
        setFlow(null);
        setPolling(false);
        return;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPolling(false);
        return;
      }
    }
    setError("Sign-in timed out. Try again.");
    setFlow(null);
    setPolling(false);
  }

  async function signOut() {
    setError(null); setMessage(null);
    try {
      await api.githubCopilotAuth.signOut();
      const s = await api.githubCopilotAuth.status();
      setStatus(s);
      setMessage("Signed out.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function copyCode(code: string) {
    try { await navigator.clipboard.writeText(code); } catch { /* ignore */ }
  }

  return (
    <div className="p-2.5 rounded-lg bg-surface-3 border border-border text-xs space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-fg-muted">
          <strong>GitHub Copilot sign-in</strong>
          <p className="text-fg-faint mt-0.5">
            Unlocks full model context windows (vs. the 8k cap on raw PATs via GitHub Models).
          </p>
        </div>
        {status?.signed_in ? (
          <button onClick={signOut} className="px-2 py-1 text-[11px] bg-surface text-fg-muted hover:text-red-700 dark:hover:text-red-300 rounded border border-border whitespace-nowrap">
            Sign out
          </button>
        ) : (
          <button
            onClick={startSignIn}
            disabled={polling}
            className="px-2 py-1 text-[11px] bg-accent hover:bg-accent-hover text-white rounded whitespace-nowrap disabled:opacity-50"
          >
            {polling ? "Waiting…" : "Sign in"}
          </button>
        )}
      </div>
      {status?.signed_in && !flow && (
        <p className="text-emerald-700 dark:text-emerald-400">Connected{status.stored_at ? ` · ${new Date(status.stored_at).toLocaleString()}` : ""}</p>
      )}
      {flow && (
        <div className="rounded bg-surface p-2 border border-border space-y-1.5">
          <p className="text-fg-subtle">
            1. Open{" "}
            <a href={flow.verification_uri} target="_blank" rel="noreferrer" className="text-accent underline">
              {flow.verification_uri}
            </a>
          </p>
          <p className="text-fg-subtle">2. Enter this code:</p>
          <div className="flex items-center gap-2">
            <code className="px-2 py-1 bg-surface-2 rounded font-mono text-fg text-sm tracking-wider">
              {flow.user_code}
            </code>
            <button onClick={() => copyCode(flow.user_code)} className="text-[10px] text-fg-subtle hover:text-fg">
              Copy
            </button>
          </div>
        </div>
      )}
      {message && <p className="text-emerald-700 dark:text-emerald-400">{message}</p>}
      {error && <p className="text-red-700 dark:text-red-400">{error}</p>}
    </div>
  );
}
