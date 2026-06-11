"use client";
import { Globe, Loader2, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/api/client";
import type { AllowedSiteStatus } from "@/api/types";

// Settings card for the allowed-sites list. A host on this list grants
// the agent two paired capabilities: (1) the browser extension may drive
// a tab on this host on the agent's behalf (browser RPC), and (2) cookies
// the extension scrapes for this host get attached to web_fetch requests.
// The two capabilities live on a single user approval — there is no way
// to enable one without the other.
//
// SSRF bypass is per-host opt-in: required to let web_fetch reach
// intranet/private-IP allow-listed hosts (e.g. an internal Confluence
// behind the corp VPN). Without it, the SSRF guard refuses the fetch
// even for an allow-listed host.
export function AllowedSitesSection() {
  const [sites, setSites] = useState<AllowedSiteStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newHost, setNewHost] = useState("");
  const [newBypass, setNewBypass] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.allowedSites.list();
      setSites(r.sites);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function add() {
    const host = newHost.trim();
    if (!host) return;
    setAdding(true);
    setError(null);
    try {
      await api.allowedSites.add({ hostname: host, ssrf_bypass: newBypass });
      setNewHost("");
      setNewBypass(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  async function toggleBypass(s: AllowedSiteStatus) {
    setError(null);
    try {
      await api.allowedSites.setSsrfBypass(s.hostname, !s.ssrf_bypass);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(s: AllowedSiteStatus) {
    if (!confirm(`Remove ${s.hostname}? The agent will lose browser-RPC and cookie access for this host.`)) return;
    setError(null);
    try {
      await api.allowedSites.remove(s.hostname);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="mb-3 rounded-lg border border-border bg-surface-2 overflow-hidden">
      <div className="px-3 py-2.5 border-b border-border/60 flex items-start gap-2">
        <Globe size={14} className="text-fg-subtle mt-0.5" />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-fg">Sites the agent can use as you</h3>
          <p className="text-[11px] text-fg-faint mt-0.5 leading-snug">
            On these sites, the Jarela browser extension may drive a tab on the agent&apos;s behalf, and the
            agent&apos;s <code>web_fetch</code> tool gets your browser&apos;s cookies for direct requests.
            One approval enables both. Cookies are stored encrypted and never shown in this UI.
          </p>
        </div>
      </div>

      <div className="px-3 py-3 space-y-2">
        {loading && <p className="text-fg-faint text-xs py-2">Loading…</p>}

        {error && (
          <div className="px-2 py-1.5 rounded bg-rose-950/40 border border-rose-800 text-xs text-rose-700 dark:text-rose-300">
            {error}
          </div>
        )}

        {!loading && sites.length === 0 && (
          <p className="text-fg-faint text-xs py-2">No approved sites yet. Add one below, or approve a host
            from the in-browser dialog when the agent first asks to use a site.</p>
        )}

        {sites.length > 0 && (
          <ul className="divide-y divide-border/60 rounded border border-border/60 bg-surface-3">
            {sites.map((s) => (
              <li key={s.hostname} className="px-2.5 py-2 flex items-center gap-3">
                <code className="text-xs text-fg font-mono flex-1 min-w-0 truncate">{s.hostname}</code>
                <span className="text-[10px] text-fg-faint shrink-0">
                  {s.has_cookies
                    ? `cookies updated ${formatRelative(s.cookies_updated_at)}`
                    : "no cookies yet"}
                </span>
                <label
                  className="text-[10px] inline-flex items-center gap-1 text-fg-muted cursor-pointer shrink-0"
                  title="Allow web_fetch to reach private/loopback addresses for this host (intranet)"
                >
                  <input
                    type="checkbox"
                    checked={s.ssrf_bypass}
                    onChange={() => toggleBypass(s)}
                    className="accent-amber-500"
                  />
                  intranet
                </label>
                <button
                  onClick={() => remove(s)}
                  className="text-fg-faint hover:text-rose-700 dark:hover:text-rose-400 shrink-0"
                  title="Remove this host"
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-2 pt-1">
          <input
            type="text"
            value={newHost}
            onChange={(e) => setNewHost(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            placeholder="jira.example.com"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            className="flex-1 px-2 py-1.5 text-sm rounded border border-border bg-surface-3 text-fg font-mono"
          />
          <label
            className="text-[11px] inline-flex items-center gap-1 text-fg-muted cursor-pointer"
            title="Allow web_fetch to reach private/loopback addresses for this host (intranet)"
          >
            <input
              type="checkbox"
              checked={newBypass}
              onChange={(e) => setNewBypass(e.target.checked)}
              className="accent-amber-500"
            />
            intranet
          </label>
          <button
            onClick={() => { void add(); }}
            disabled={adding || !newHost.trim()}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {adding ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
            Approve
          </button>
        </div>

        {newBypass && (
          <div className="px-2 py-1.5 rounded bg-amber-950/30 border border-amber-800 text-[11px] text-amber-700 dark:text-amber-300 inline-flex items-start gap-1.5">
            <ShieldAlert size={12} className="mt-0.5 shrink-0" />
            <span>
              Intranet bypass lets the agent reach private/loopback addresses for this host. Only enable for
              hosts you actually run on the corp network.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "never";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
