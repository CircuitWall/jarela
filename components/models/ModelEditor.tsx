"use client";
import { BookOpen, CheckCircle2, Loader2, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { api } from "@/api/client";
import type { CatalogModel, Credential, IntegrationStatus, ModelConfig } from "@/api/types";
import { useAppContext } from "@/contexts/AppContext";
import { pushErrorToast } from "@/lib/ui/error-report";
import { buildModelEditorPayload } from "@/lib/models/editor-payload";
import { CapBadges } from "./CapBadges";
import { ModelFeatureGuide } from "./ModelFeatureGuide";
import { CredentialEditor } from "@/components/credentials/CredentialEditor";

const FALLBACK_PROVIDERS = ["anthropic", "openai", "github-copilot", "deepseek", "gemini", "langchain"];

// Providers without a `listModels` plugin still respond to the catalog
// endpoint — they just return `[]`. We surface the Browse button for every
// provider and let the empty-state UI explain when no catalog is published.
// This avoids a hardcoded allowlist that would force every new provider
// (including out-of-tree overlays) to patch this file.

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
  const isFullMode = state.experienceMode === "full";
  // Per-editor opt-in so a normal-mode user can reveal the engine-room
  // fields for one model without flipping the global workspace mode.
  const [showExpert, setShowExpert] = useState(false);
  const expertVisible = isFullMode || showExpert;
  const isEdit = !!model;
  const [name, setName] = useState(model?.name ?? "");
  // Tracks whether the user has edited the name field directly. While false
  // (default for new configs), the name auto-mirrors model_id so the user
  // doesn't have to type "claude-sonnet-4-6" twice.
  const [nameTouched, setNameTouched] = useState(isEdit);
  const [provider, setProvider] = useState(model?.provider ?? "anthropic");
  const [providers, setProviders] = useState<string[]>(FALLBACK_PROVIDERS);
  const [modelId, setModelId] = useState(model?.model_id ?? "");
  // Credential binding. When set, secret fields live in the credential
  // row and the inline api_key field is hidden (the credential UI owns
  // it). Inline base_url / extra_headers / api_key still act as
  // per-model overrides if the user reveals advanced fields, since the
  // server merges credential params UNDER inline params.
  const [credentialId, setCredentialId] = useState<string | null>(model?.credential_id ?? null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [credentialDialog, setCredentialDialog] = useState<Credential | { creating: true } | null>(null);
  const [apiKey, setApiKey] = useState(model?.params.api_key === "***" ? "" : (model?.params.api_key ?? ""));
  const [baseUrl, setBaseUrl] = useState(model?.params.base_url ?? "");

  const [extraHeaders, setExtraHeaders] = useState(
    model?.params.extra_headers ? JSON.stringify(model.params.extra_headers, null, 2) : ""
  );
  const [temperature, setTemperature] = useState(String(model?.params.temperature ?? ""));
  const [maxTokens, setMaxTokens] = useState(String(model?.params.max_tokens ?? ""));
  const [contextWindowTokens, setContextWindowTokens] = useState(String(model?.params.context_window_tokens ?? ""));
  // Tracks values most recently auto-filled from the catalog. When the live
  // input matches, we label the field as catalog-default; once the user edits
  // it, the marker clears and we treat the value as an explicit override.
  const [autoMaxTokens, setAutoMaxTokens] = useState<string | null>(null);
  const [autoContextWindowTokens, setAutoContextWindowTokens] = useState<string | null>(null);
  const [isDefault, setIsDefault] = useState(model?.is_default ?? false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Probe state — lets the user click "Test" before saving, AND the save
  // path auto-probes so embedding-only or unauthorized models don't get
  // persisted only to fail when an agent actually tries to use them.
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [allowSaveAnyway, setAllowSaveAnyway] = useState(false);

  // Compaction state — when the operator shrinks the context (smaller
  // window, or different model_id) on an existing config, offer to run
  // the warm summary using the OLD provider snapshot before completing
  // the save. Without this, the first turn under the new model can fail
  // because compaction itself doesn't fit the new budget.
  const [compacting, setCompacting] = useState(false);
  const [pendingShrinkConfirm, setPendingShrinkConfirm] = useState<
    | null
    | {
        oldSnapshot: { provider: string; model_id: string; params: Record<string, unknown> };
        payloadName: string;
        payload: Omit<ModelConfig, "name" | "created_at" | "updated_at">;
      }
  >(null);

  // Catalog state
  const [showCatalog, setShowCatalog] = useState(false);
  const [catalog, setCatalog] = useState<CatalogModel[] | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);

  useEscapeKey(onClose);

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

  useEffect(() => {
    let mounted = true;
    api.integrations.list()
      .then((res) => {
        if (!mounted) return;
        setIntegrations(res.statuses);
      })
      .catch(() => {
        if (!mounted) return;
        setIntegrations([]);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Refresh the credential list whenever the user creates / edits one
  // from inside this editor, or switches to a different provider so the
  // dropdown narrows.
  const refreshCredentials = async () => {
    try {
      const rows = await api.credentials.list({ type: "model" });
      setCredentials(rows);
    } catch {
      setCredentials([]);
    }
  };
  useEffect(() => {
    refreshCredentials();
    const onChange = () => refreshCredentials();
    if (typeof window !== "undefined") window.addEventListener("jarela:credentials-changed", onChange);
    return () => {
      if (typeof window !== "undefined") window.removeEventListener("jarela:credentials-changed", onChange);
    };
  }, []);

  // Default the credential picker to the first credential matching the
  // current provider once the list arrives — but only on a NEW config,
  // and only when the user hasn't already chosen one. Edits keep
  // whatever the model row already references.
  const providerCredentials = useMemo(
    () => credentials.filter((c) => c.provider === provider),
    [credentials, provider],
  );
  useEffect(() => {
    if (isEdit) return;
    if (credentialId) return;
    if (providerCredentials.length === 0) return;
    setCredentialId(providerCredentials[0].id);
  }, [isEdit, credentialId, providerCredentials]);

  // When the user changes the provider, drop a credential binding that
  // no longer matches so we don't ship a mismatched secret to the
  // backend on save.
  useEffect(() => {
    if (!credentialId) return;
    const stillValid = credentials.some((c) => c.id === credentialId && c.provider === provider);
    if (!stillValid) setCredentialId(null);
  }, [provider, credentialId, credentials]);

  // Reset catalog when provider changes
  useEffect(() => {
    setCatalog(null);
    setCatalogError(null);
    setShowCatalog(false);
  }, [provider]);

  async function loadCatalog() {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      // Forward the in-form credentials so a freshly-typed api_key /
      // base_url works before the user has saved the config. The server
      // layers these on top of any persisted creds for the same provider.
      const overrides: Record<string, unknown> = {};
      if (apiKey.trim()) overrides.api_key = apiKey.trim();
      if (baseUrl.trim()) overrides.base_url = baseUrl.trim();
      if (extraHeaders.trim()) {
        try { overrides.extra_headers = JSON.parse(extraHeaders); }
        catch { /* invalid JSON — ignore for the catalog probe */ }
      }
      const hasOverrides = Object.keys(overrides).length > 0;
      const models = await api.models.catalog(provider, hasOverrides ? overrides : undefined);
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
    const result = buildModelEditorPayload({
      name,
      provider,
      model_id: modelId,
      api_key: apiKey,
      base_url: baseUrl,
      extra_headers: extraHeaders,
      temperature,
      max_tokens: maxTokens,
      context_window_tokens: contextWindowTokens,
      is_default: isDefault,
      credential_id: credentialId,
    });
    if (!result.ok) { setError(result.error); return; }
    setSaving(true);
    try {
      // Auto-probe: don't persist a model that can't open a chat stream
      // (typical case: github-copilot embedding-only models that 404 on
      // chat completions). User can override via "Save anyway".
      if (!allowSaveAnyway) {
        const probe = await api.models.probe(
          provider,
          result.payload.model_id,
          result.payload.params as Record<string, unknown>,
          undefined,
          credentialId ?? undefined,
        ).catch((e) => ({ ok: false, error: String(e instanceof Error ? e.message : e) }));
        setProbeResult(probe);
        if (!probe.ok) {
          setError(`Model probe failed: ${probe.error || "unknown error"}. Use "Save anyway" if this is intentional.`);
          setAllowSaveAnyway(true);
          setSaving(false);
          return;
        }
      }

      // Shrink-guard: if the operator is editing an existing config and
      // either the context window dropped OR the model_id changed, stage
      // a confirmation that will compact warm summaries with the OLD
      // model snapshot before completing the save.
      if (isEdit && model) {
        const oldCtx = Number(model.params.context_window_tokens) || 0;
        const newCtx = Number(result.payload.params.context_window_tokens) || 0;
        const ctxShrunk = oldCtx > 0 && newCtx > 0 && newCtx < oldCtx;
        const modelIdChanged = model.model_id !== result.payload.model_id;
        if (ctxShrunk || modelIdChanged) {
          setPendingShrinkConfirm({
            oldSnapshot: {
              provider: model.provider,
              model_id: model.model_id,
              params: model.params as Record<string, unknown>,
            },
            payloadName: result.name,
            payload: result.payload,
          });
          setSaving(false);
          return;
        }
      }

      await onSave(result.name, result.payload);
      onClose();
    } catch (e) {
      pushErrorToast({
        title: "Couldn't save model",
        error: e,
        context: { panel: "models", action: "model.save", name: result.name, provider, model_id: result.payload.model_id },
      });
    }
    finally { setSaving(false); }
  }

  async function handleTestConnection() {
    setProbeResult(null);
    if (!modelId.trim()) { setProbeResult({ ok: false, error: "model_id required" }); return; }
    setProbing(true);
    try {
      const overrides: Record<string, unknown> = {};
      if (apiKey.trim()) overrides.api_key = apiKey.trim();
      if (baseUrl.trim()) overrides.base_url = baseUrl.trim();
      if (extraHeaders.trim()) {
        try { overrides.extra_headers = JSON.parse(extraHeaders); }
        catch { /* invalid JSON — ignore */ }
      }
      const res = await api.models.probe(
        provider,
        modelId.trim(),
        Object.keys(overrides).length > 0 ? overrides : undefined,
        isEdit ? model?.name : undefined,
        credentialId ?? undefined,
      );
      setProbeResult(res);
      if (res.ok) setAllowSaveAnyway(false);
    } catch (e) {
      setProbeResult({ ok: false, error: String(e instanceof Error ? e.message : e) });
    } finally {
      setProbing(false);
    }
  }

  async function confirmShrinkAndSave() {
    if (!pendingShrinkConfirm) return;
    const { oldSnapshot, payloadName, payload } = pendingShrinkConfirm;
    setCompacting(true);
    try {
      // Compact FIRST with the old snapshot — works even though the model
      // hasn't been swapped yet because the endpoint accepts the provider
      // info inline rather than reading it back from the DB row.
      await api.models.compactThreads(payloadName, oldSnapshot);
      await onSave(payloadName, payload);
      setPendingShrinkConfirm(null);
      onClose();
    } catch (e) {
      pushErrorToast({
        title: "Couldn't compact threads before model swap",
        error: e,
        context: { panel: "models", action: "model.compact", name: payloadName },
      });
    } finally {
      setCompacting(false);
    }
  }

  async function skipCompactAndSave() {
    if (!pendingShrinkConfirm) return;
    const { payloadName, payload } = pendingShrinkConfirm;
    setSaving(true);
    try {
      await onSave(payloadName, payload);
      setPendingShrinkConfirm(null);
      onClose();
    } catch (e) {
      pushErrorToast({
        title: "Couldn't save model",
        error: e,
        context: { panel: "models", action: "model.save", name: payloadName, provider, model_id: payload.model_id },
      });
    } finally {
      setSaving(false);
    }
  }

  const showGitHub = provider === "github-copilot";

  const filteredCatalog = catalog?.filter((m) =>
    !catalogSearch || m.id.toLowerCase().includes(catalogSearch.toLowerCase())
  ) ?? [];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 p-2 sm:p-4 overflow-y-auto">
      <div className={`bg-surface-2 border border-border rounded-2xl w-full shadow-xl my-2 sm:my-4 ${expertVisible ? "max-w-2xl" : "max-w-xl"}`}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-fg">{isEdit ? "Edit model config" : "New model config"}</h3>
          <button onClick={onClose} className="text-fg-subtle hover:text-fg transition-colors"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-3.5">
          {!isFullMode && (
            <button
              type="button"
              onClick={() => setShowExpert((v) => !v)}
              aria-expanded={showExpert}
              className="text-[11px] text-fg-faint hover:text-fg-muted transition-colors inline-flex items-center gap-1"
            >
              {showExpert ? "Hide advanced fields" : "Show advanced fields (context tuning, base URL, headers)"}
            </button>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">Config name</span>
              <input className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                value={name}
                onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
                placeholder={modelId || "e.g. work-claude"} disabled={isEdit} />
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
              <button
                onClick={() => showCatalog ? setShowCatalog(false) : loadCatalog()}
                disabled={catalogLoading}
                className="flex items-center gap-1 text-[11px] text-accent hover:text-accent/80 transition-colors disabled:opacity-50"
              >
                <BookOpen size={11} />
                {catalogLoading ? "Loading…" : showCatalog ? "Hide catalog" : "Browse catalog"}
              </button>
            </div>
            <input
              className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
              value={modelId}
              onChange={(e) => {
                const next = e.target.value;
                setModelId(next);
                if (!nameTouched && !isEdit) setName(next);
              }}
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
                      onClick={() => {
                        setModelId(m.id);
                        if (!nameTouched && !isEdit) setName(m.id);
                        // Auto-apply the catalog's known sizing as the default so
                        // the agent doesn't fall back to the global 8K window.
                        // Only fills when the field is currently empty — never
                        // clobbers a value the user explicitly typed.
                        if (m.context_length && !contextWindowTokens.trim()) {
                          const v = String(m.context_length);
                          setContextWindowTokens(v);
                          setAutoContextWindowTokens(v);
                        }
                        if (m.max_output_tokens && !maxTokens.trim()) {
                          const v = String(m.max_output_tokens);
                          setMaxTokens(v);
                          setAutoMaxTokens(v);
                        }
                        setShowCatalog(false);
                      }}
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

          <ModelFeatureGuide provider={provider} modelId={modelId} models={model ? [model] : []} integrations={integrations} />



          {showGitHub && <GitHubCopilotAuth />}

          {/* Credential picker — primary surface for binding secrets.
              Hides the inline api_key field when a credential is bound,
              since the credential row owns the secret. */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-fg-subtle">Credential</span>
              <button
                type="button"
                onClick={() => setCredentialDialog({ creating: true })}
                className="text-[11px] text-accent hover:text-accent/80 transition-colors inline-flex items-center gap-1"
              >
                + New credential
              </button>
            </div>
            <select
              className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
              value={credentialId ?? ""}
              onChange={(e) => setCredentialId(e.target.value || null)}
            >
              <option value="">
                {providerCredentials.length === 0 ? `— No credentials for ${provider} —` : `— Inline / env fallback —`}
              </option>
              {providerCredentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id} ({c.auth_method})
                </option>
              ))}
              {credentialId && !providerCredentials.some((c) => c.id === credentialId) && (
                <option value={credentialId}>{credentialId} (other provider)</option>
              )}
            </select>
            {credentialId && (
              <button
                type="button"
                onClick={() => {
                  const cred = credentials.find((c) => c.id === credentialId);
                  if (cred) setCredentialDialog(cred);
                }}
                className="text-[11px] text-fg-faint hover:text-fg-muted transition-colors"
              >
                Edit selected credential
              </button>
            )}
          </div>

          {/* Inline API Key only when no credential bound — lets the
              env-fallback case continue to work AND lets a user paste a
              one-off key without forcing them into the credential UI
              first. When a credential is bound, the field stays
              available as an advanced override below. */}
          {!credentialId && (
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">
                API Key
                <span className="ml-1 text-fg-faint">(optional — env fallback used if blank)</span>
              </span>
              <input type="password" className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="••••••••" />
            </label>
          )}

          {expertVisible && credentialId && (
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">API Key override (advanced)</span>
              <input type="password" className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="leave blank — credential value used" />
            </label>
          )}

          {expertVisible && (
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
              <span className="text-xs text-fg-subtle mb-1 block">
                Max tokens
                {autoMaxTokens !== null && autoMaxTokens === maxTokens && (
                  <span className="ml-1 text-fg-faint">(catalog default)</span>
                )}
              </span>
              <input type="number" className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                value={maxTokens}
                onChange={(e) => {
                  setMaxTokens(e.target.value);
                  if (e.target.value !== autoMaxTokens) setAutoMaxTokens(null);
                }}
                placeholder="4096" />
            </label>
          </div>

          {expertVisible && (
            <>
              <label className="block">
                <span className="text-xs text-fg-subtle mb-1 block">
                  Context window tokens
                  {autoContextWindowTokens !== null && autoContextWindowTokens === contextWindowTokens && (
                    <span className="ml-1 text-fg-faint">(catalog default)</span>
                  )}
                </span>
                <input type="number" min="1" className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                  value={contextWindowTokens}
                  onChange={(e) => {
                    setContextWindowTokens(e.target.value);
                    if (e.target.value !== autoContextWindowTokens) setAutoContextWindowTokens(null);
                  }}
                  placeholder="8192" />
              </label>

            </>
          )}

          {expertVisible && (
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
          {probeResult && (
            <div
              className={`text-xs flex items-start gap-1.5 px-2 py-1.5 rounded border ${
                probeResult.ok
                  ? "bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-800 text-green-700 dark:text-green-300"
                  : "bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-800 text-red-700 dark:text-red-300"
              }`}
            >
              {probeResult.ok ? <CheckCircle2 size={13} className="shrink-0 mt-0.5" /> : <XCircle size={13} className="shrink-0 mt-0.5" />}
              <span className="min-w-0 break-words">
                {probeResult.ok ? "Connection OK — the model responded to a probe." : `Probe failed: ${probeResult.error || "unknown error"}`}
              </span>
            </div>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 px-4 pb-4 pt-1 border-t border-border/60">
          <button
            onClick={handleTestConnection}
            disabled={probing || !modelId.trim()}
            className="px-3 py-1.5 text-sm text-fg-muted hover:text-fg transition-colors inline-flex items-center gap-1.5 disabled:opacity-40"
          >
            {probing && <Loader2 size={13} className="animate-spin" />}
            {probing ? "Testing…" : "Test connection"}
          </button>
          <div className="flex-1" />
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-fg-subtle hover:text-fg transition-colors">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="px-4 py-1.5 text-sm font-medium bg-accent hover:bg-accent-hover text-white rounded-xl shadow-sm transition-colors disabled:opacity-50">
            {saving ? "Saving…" : allowSaveAnyway ? "Save anyway" : "Save"}
          </button>
        </div>
      </div>
      {pendingShrinkConfirm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] p-4">
          <div className="bg-surface-2 border border-border rounded-2xl w-full max-w-md shadow-2xl p-5 space-y-3">
            <h4 className="text-sm font-semibold text-fg">Compact threads first?</h4>
            <p className="text-xs text-fg-muted leading-relaxed">
              You&apos;re switching <span className="font-mono">{pendingShrinkConfirm.payloadName}</span> from{" "}
              <span className="font-mono">{pendingShrinkConfirm.oldSnapshot.model_id}</span> to{" "}
              <span className="font-mono">{pendingShrinkConfirm.payload.model_id}</span>. The new model may have a smaller
              context window. To avoid the next turn failing, Jarela can summarize older messages now using the previous
              model, then complete the swap.
            </p>
            <p className="text-[11px] text-fg-faint">Other actions are blocked while compaction runs.</p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => { setPendingShrinkConfirm(null); }}
                disabled={compacting}
                className="px-3 py-1.5 text-xs text-fg-subtle hover:text-fg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={skipCompactAndSave}
                disabled={compacting || saving}
                className="px-3 py-1.5 text-xs text-fg-muted hover:text-fg transition-colors"
              >
                Skip &amp; save anyway
              </button>
              <button
                onClick={confirmShrinkAndSave}
                disabled={compacting}
                className="px-4 py-1.5 text-xs font-medium bg-accent hover:bg-accent-hover text-white rounded-xl shadow-sm transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {compacting && <Loader2 size={12} className="animate-spin" />}
                {compacting ? "Compacting…" : "Compact &amp; save"}
              </button>
            </div>
          </div>
        </div>
      )}
      {credentialDialog && (
        <CredentialEditor
          credential={"creating" in credentialDialog ? undefined : credentialDialog}
          defaults={{ type: "model", provider }}
          providers={providers}
          lockType
          onSaved={(cred) => {
            // Auto-bind the freshly created/edited credential so the
            // user's next action ("Save model") uses it without needing
            // to re-pick from the dropdown.
            setCredentialId(cred.id);
            refreshCredentials();
          }}
          onClose={() => setCredentialDialog(null)}
        />
      )}
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
