"use client";
import { Globe, Loader2, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { ProxyApplyResult, ProxyConfigEnvelope, ProxyMode } from "@/api/types";

const SECRET_MASK = "********";

// Network / proxy configuration card (ADR-0009). Lives inside the
// Integrations tab so all credential-bearing config sits in one place
// rather than getting its own top-level menu entry.
export function NetworkSection() {
  const [env, setEnv] = useState<ProxyConfigEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProxyApplyResult | null>(null);

  // Editable form state. Re-seeded from server on load and after save.
  const [mode, setMode] = useState<ProxyMode>("off");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [noProxy, setNoProxy] = useState("");

  async function load() {
    setLoading(true);
    try {
      const r = await api.proxy.get();
      setEnv(r);
      seed(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function seed(r: ProxyConfigEnvelope) {
    const c = r.config;
    setMode(c.mode);
    setHost(c.host ?? "");
    setPort(c.port != null ? String(c.port) : "");
    setUsername(c.username ?? "");
    setPassword(c.password ?? "");
    setNoProxy(c.no_proxy ?? "");
  }

  useEffect(() => { void load(); }, []);

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const r = await api.proxy.save({
        mode,
        host: host.trim() || null,
        port: port.trim() ? Number.parseInt(port, 10) : null,
        username: username.trim() || null,
        password: password.length > 0 ? password : null,
        no_proxy: noProxy.trim() || null,
      });
      setEnv(r);
      seed(r);
      setResult(r.applied ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    if (!confirm("Clear saved proxy configuration?")) return;
    setError(null);
    try {
      const r = await api.proxy.clear();
      setEnv(r);
      seed(r);
      setResult(r.applied ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const envOverride = env?.env_override ?? false;
  const configured = env?.config.mode !== "off" && env?.config.updated_at != null;

  return (
    <div className="mb-3 rounded-lg border border-border bg-surface-2 overflow-hidden">
      <div className="px-3 py-2.5 border-b border-border/60 flex items-start gap-2">
        <Globe size={14} className="text-fg-subtle mt-0.5" />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-fg">Network proxy</h3>
          <p className="text-[11px] text-fg-faint mt-0.5 leading-snug">
            HTTP proxy for outbound calls (LLM providers, MCP servers, integrations). Stored encrypted.
            Changes apply to new requests immediately; in-flight streams finish on the previous proxy.
          </p>
        </div>
      </div>

      <div className="px-3 py-3 space-y-2">
        {loading && <p className="text-fg-faint text-xs py-2">Loading…</p>}

        {envOverride && (
          <div className="px-2 py-1.5 rounded bg-amber-950/30 border border-amber-800 text-[11px] text-amber-700 dark:text-amber-300">
            <code>HTTPS_PROXY</code> is set in the process environment. The in-app config is saved but not applied
            while the env var is present.
          </div>
        )}

        {!loading && (
          <>
            <label className="block text-xs text-fg-subtle">
              Mode
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as ProxyMode)}
                className="mt-1 w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-3 text-fg"
              >
                <option value="off">Off — direct connection</option>
                <option value="manual">Manual — host / port below</option>
                <option value="system">System (macOS) — import from scutil --proxy</option>
              </select>
            </label>

            {mode === "manual" && (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <label className="col-span-2 block text-xs text-fg-subtle">
                    Host
                    <input
                      type="text"
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                      placeholder="proxy.corp.example"
                      className="mt-1 w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-3 text-fg font-mono"
                    />
                  </label>
                  <label className="block text-xs text-fg-subtle">
                    Port
                    <input
                      type="number"
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      placeholder="8080"
                      className="mt-1 w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-3 text-fg font-mono"
                    />
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-xs text-fg-subtle">
                    Username (optional)
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder=""
                      className="mt-1 w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-3 text-fg font-mono"
                    />
                  </label>
                  <label className="block text-xs text-fg-subtle">
                    Password (optional)
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onFocus={(e) => {
                        // Clicking the masked sentinel clears the field so the
                        // user can type a new password without manually erasing
                        // the dots.
                        if (e.target.value === SECRET_MASK) setPassword("");
                      }}
                      placeholder=""
                      className="mt-1 w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-3 text-fg font-mono"
                    />
                  </label>
                </div>
              </>
            )}

            {mode !== "off" && (
              <label className="block text-xs text-fg-subtle">
                No proxy (comma-separated, optional)
                <input
                  type="text"
                  value={noProxy}
                  onChange={(e) => setNoProxy(e.target.value)}
                  placeholder="localhost,127.0.0.1,.internal"
                  className="mt-1 w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-3 text-fg font-mono"
                />
              </label>
            )}

            {error && (
              <div className="px-2 py-1.5 rounded bg-rose-950/40 border border-rose-800 text-xs text-rose-700 dark:text-rose-300">
                {error}
              </div>
            )}

            {result && (
              <div className="px-2 py-1.5 rounded bg-surface-3 border border-border text-[11px] text-fg-muted">
                Applied: <code className="text-fg">{result.source}</code>
                {result.proxyUrl && <> → <code className="text-fg">{result.proxyUrl}</code></>}
                {result.note && <span className="text-fg-faint"> — {result.note}</span>}
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={save}
                disabled={saving}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                {saving ? "Saving…" : "Save & apply"}
              </button>
              {configured && (
                <button
                  onClick={clear}
                  className="ml-auto inline-flex items-center gap-1 px-2 py-1.5 text-xs text-fg-faint hover:text-rose-700 dark:hover:text-rose-400"
                  title="Clear saved proxy configuration"
                >
                  <Trash2 size={11} /> Clear
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
