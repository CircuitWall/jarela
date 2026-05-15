"use client";
import { BookOpen, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { CatalogModel, ModelConfig } from "@/api/types";

const FALLBACK_PROVIDERS = ["anthropic", "openai", "github-copilot", "deepseek", "gemini", "langchain"];

const CATALOG_PROVIDERS = new Set<string>(["openai", "github-copilot", "anthropic", "gemini", "deepseek"]);

interface Props {
  model?: ModelConfig;
  onSave: (name: string, data: Omit<ModelConfig, "name" | "created_at" | "updated_at">) => Promise<void>;
  onClose: () => void;
}

const CAP_LABELS: Record<keyof CatalogModel["capabilities"], string> = {
  vision: "👁 vision",
  tools: "🔧 tools",
  streaming: "⚡ stream",
  json_mode: "{} json",
  web_search: "🌐 search",
};

function CapBadges({ caps }: { caps: CatalogModel["capabilities"] }) {
  const active = (Object.entries(caps) as [keyof typeof caps, boolean][]).filter(([, v]) => v);
  if (!active.length) return null;
  return (
    <span className="flex flex-wrap gap-0.5">
      {active.map(([k]) => (
        <span key={k} className="px-1 py-0.5 rounded text-[9px] bg-surface text-zinc-400 border border-border whitespace-nowrap">
          {CAP_LABELS[k]}
        </span>
      ))}
    </span>
  );
}

function fmtCtx(n: number | null) {
  if (!n) return null;
  return n >= 1000000 ? `${n / 1000000}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export function ModelEditor({ model, onSave, onClose }: Props) {
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
      setCatalogError(String(e));
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
      if (apiKey) params.api_key = apiKey;
      if (baseUrl) params.base_url = baseUrl;
      if (parsed_headers) params.extra_headers = parsed_headers;
      if (temperature) params.temperature = Number(temperature);
      if (maxTokens) params.max_tokens = Number(maxTokens);
      await onSave(name.trim(), { provider, model_id: modelId.trim(), params, is_default: isDefault });
      onClose();
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }

  const showGitHub = provider === "github-copilot";

  const filteredCatalog = catalog?.filter((m) =>
    !catalogSearch || m.id.toLowerCase().includes(catalogSearch.toLowerCase())
  ) ?? [];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-surface-2 border border-border rounded-2xl w-full max-w-lg shadow-xl my-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-zinc-100">{isEdit ? "Edit model config" : "New model config"}</h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 transition-colors"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-zinc-400 mb-1 block">Config name</span>
              <input className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. work-claude" disabled={isEdit} />
            </label>
            <label className="block">
              <span className="text-xs text-zinc-400 mb-1 block">Provider</span>
              <select className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                value={provider} onChange={(e) => setProvider(e.target.value)}>
                {providers.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          </div>

          {/* Model ID + catalog browse */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-400">Model ID</span>
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
              className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="e.g. claude-sonnet-4-6"
            />
            {catalogError && <p className="text-red-400 text-xs">{catalogError}</p>}

            {/* Catalog panel */}
            {showCatalog && catalog && (
              <div className="border border-border rounded-lg overflow-hidden bg-surface-3">
                <div className="px-2 py-1.5 border-b border-border">
                  <input
                    className="w-full bg-surface text-zinc-100 text-xs rounded px-2 py-1 border border-border focus:outline-none focus:ring-1 focus:ring-accent placeholder-zinc-600"
                    placeholder="Filter models…"
                    value={catalogSearch}
                    onChange={(e) => setCatalogSearch(e.target.value)}
                  />
                </div>
                <div className="max-h-52 overflow-y-auto divide-y divide-border">
                  {filteredCatalog.length === 0 && (
                    <p className="text-xs text-zinc-500 text-center py-3">No models match</p>
                  )}
                  {filteredCatalog.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => { setModelId(m.id); setShowCatalog(false); }}
                      className={`w-full text-left px-3 py-2 hover:bg-surface-2 transition-colors ${m.id === modelId ? "bg-accent/10 border-l-2 border-accent" : ""}`}
                    >
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-xs font-mono text-zinc-100 truncate">{m.id}</span>
                        {m.context_length && (
                          <span className="text-[10px] text-zinc-500 shrink-0">{fmtCtx(m.context_length)} ctx</span>
                        )}
                        {m.hosted_on && (
                          <span className="text-[10px] text-zinc-600 shrink-0 truncate">{m.hosted_on}</span>
                        )}
                      </div>
                      <CapBadges caps={m.capabilities} />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>



          {showGitHub && (
            <div className="p-2.5 rounded-lg bg-surface-3 border border-border text-xs text-zinc-400">
              Use a <strong className="text-zinc-300">Copilot session token</strong> for chat access.
              Personal Access Tokens are not accepted directly by the Copilot chat endpoint.
            </div>
          )}

          <label className="block">
            <span className="text-xs text-zinc-400 mb-1 block">API Key</span>
            <input type="password" className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
              value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="••••••••" />
          </label>

          <label className="block">
            <span className="text-xs text-zinc-400 mb-1 block">Base URL (optional override)</span>
            <input className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
              value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://custom-endpoint" />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-zinc-400 mb-1 block">Temperature</span>
              <input type="number" min="0" max="2" step="0.1" className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                value={temperature} onChange={(e) => setTemperature(e.target.value)} placeholder="0.7" />
            </label>
            <label className="block">
              <span className="text-xs text-zinc-400 mb-1 block">Max tokens</span>
              <input type="number" className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="4096" />
            </label>
          </div>

          <label className="block">
            <span className="text-xs text-zinc-400 mb-1 block">Extra headers (JSON, optional)</span>
            <textarea className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent font-mono h-20 resize-none"
              value={extraHeaders} onChange={(e) => setExtraHeaders(e.target.value)} placeholder='{"X-Custom": "value"}' />
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="rounded border-border" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            <span className="text-xs text-zinc-300">Set as default model</span>
          </label>

          {error && <p className="text-red-400 text-xs">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-4 pb-4">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-100 transition-colors">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="px-4 py-1.5 text-sm bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
