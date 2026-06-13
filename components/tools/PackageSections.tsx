"use client";

import { useEffect, useState } from "react";
import { Boxes, AlertTriangle } from "lucide-react";
import { api } from "@/api/client";
import { usePackages } from "@/hooks/usePackages";
import { pushErrorToast } from "@/lib/ui/error-report";
import type { DefaultLangChainPackageInfo } from "@/api/types";
import { useAppContext } from "@/contexts/AppContext";

// Toggleable default LangChain packages (Atlassian / GitHub / Jira Align).
// Each one ships with Jarela but can be hidden via the disabled_packages
// store. Disabling unregisters the tool surface live; the operator can
// flip it back on without restart.
export function DefaultPackagesSection() {
  const { dispatch } = useAppContext();
  const { loadResult, refresh, setDefaultEnabled } = usePackages();
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const defaults = loadResult?.defaults ?? [];

  async function toggle(pkg: DefaultLangChainPackageInfo) {
    setBusy((b) => ({ ...b, [pkg.id]: true }));
    try {
      await setDefaultEnabled(pkg.id, !pkg.enabled);
    } catch (e) {
      pushErrorToast({
        title: "Couldn't toggle package",
        error: e,
        context: { panel: "packages", action: "toggle-default", id: pkg.id, target_enabled: !pkg.enabled },
      });
    } finally {
      setBusy((b) => ({ ...b, [pkg.id]: false }));
    }
  }

  function openCredentials(integrationId: string) {
    dispatch({ type: "SET_TAB", tab: "settings" });
    dispatch({ type: "SET_SELECTION", tab: "settings", itemId: "credentials" });
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", "settings");
      url.searchParams.set("item", "credentials");
      url.searchParams.set("scrollTo", integrationId);
      window.history.replaceState({}, "", url.toString());
    }
  }

  return (
    <section className="space-y-3">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Boxes size={14} className="text-fg-faint" />
          <h3 className="text-sm font-semibold text-fg">Default packages</h3>
        </div>
        <p className="text-xs text-fg-faint">
          Bundled LangChain tool packages. Disable to hide them from agents
          without uninstalling the npm dependency. Re-enable any time.
        </p>
      </header>

      {defaults.length === 0 ? (
        <p className="text-xs text-fg-faint py-2">Loading…</p>
      ) : (
        <ul className="space-y-2">
          {defaults.map((pkg) => {
            const total = pkg.toolCounts.read + pkg.toolCounts.write + pkg.toolCounts.execute;
            return (
              <li
                key={pkg.id}
                className="rounded-lg border border-border bg-surface-2 px-3 py-2.5"
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-fg">{pkg.label}</span>
                      <span className="text-[11px] text-fg-faint">
                        {total} tool{total === 1 ? "" : "s"}
                      </span>
                      <span className="text-[11px] text-fg-faint">
                        ({pkg.toolCounts.read} read · {pkg.toolCounts.write} write ·{" "}
                        {pkg.toolCounts.execute} execute)
                      </span>
                    </div>
                    <p className="text-xs text-fg-muted mt-0.5">{pkg.description}</p>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <code className="text-[10px] text-fg-faint font-mono">
                        {pkg.npmPackage}
                      </code>
                      <button
                        type="button"
                        onClick={() => openCredentials(pkg.integrationId)}
                        className="text-[11px] text-accent hover:text-accent-hover underline-offset-2 hover:underline"
                      >
                        Configure credentials
                      </button>
                    </div>
                  </div>
                  <label className="text-[11px] text-fg-faint flex items-center gap-1 select-none shrink-0 pt-0.5">
                    <input
                      type="checkbox"
                      checked={pkg.enabled}
                      disabled={Boolean(busy[pkg.id])}
                      onChange={() => void toggle(pkg)}
                    />
                    enabled
                  </label>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {loadResult && loadResult.errors.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 space-y-1">
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-800 dark:text-amber-300">
            <AlertTriangle size={13} />
            Manifest load errors
          </div>
          <ul className="space-y-1 text-xs text-fg-muted">
            {loadResult.errors.map((e) => (
              <li key={e.manifest}>
                <span className="font-mono">{e.manifest}</span>: {e.error}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => void refresh()}
            className="text-[11px] text-accent hover:text-accent-hover"
          >
            Re-scan
          </button>
        </div>
      )}
    </section>
  );
}

// ── Drop-in tools section ──────────────────────────────────────────────────
// Hot-loaded `.cjs` files from `$JARELA_TOOLS_DIR`. These behave like
// any LangChain tool from the agent's perspective; this surface is
// read-only listing + an editor for any per-tool secret slots the file
// declared.

import type { ExtensionsListResponse, ExternalToolInfo } from "@/api/types";
import { KeyRound, AlertCircle } from "lucide-react";

const SECRET_MASK = "********";

export function DropInToolsSection() {
  const [data, setData] = useState<ExtensionsListResponse | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      setData(await api.extensions.list());
    } catch (e) {
      pushErrorToast({
        title: "Couldn't load drop-in tools",
        error: e,
        context: { panel: "packages", action: "list-extensions" },
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <section className="space-y-3">
      <header className="space-y-1">
        <h3 className="text-sm font-semibold text-fg">Drop-in tools</h3>
        <p className="text-xs text-fg-faint">
          Hot-loaded <code className="font-mono text-[11px]">.cjs</code> files
          from <span className="font-mono">{data?.directories.tools ?? "$JARELA_TOOLS_DIR"}</span>.
          Drop a file in and it&apos;s picked up on the next request — see
          {" "}
          <code className="font-mono text-[11px]">lib/tools/template-external.cjs.example</code>
          {" "}for the contract.
        </p>
      </header>

      {loading && !data && (
        <p className="text-fg-faint text-sm py-3 text-center">Loading…</p>
      )}

      {data && data.tools.length === 0 && (
        <p className="text-xs text-fg-faint py-2">
          No drop-in tools loaded. Add a <code className="font-mono">.cjs</code>{" "}
          file to <span className="font-mono">{data.directories.tools}</span>.
        </p>
      )}

      {data && data.tools.length > 0 && (
        <ul className="space-y-2">
          {data.tools.map((t) => (
            <DropInToolRow key={t.name} tool={t} onSaved={() => void load()} />
          ))}
        </ul>
      )}

      {data && data.errors.filter((e) => e.kind === "tool").length > 0 && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2.5 space-y-1">
          <div className="flex items-center gap-2 text-xs font-semibold text-rose-800 dark:text-rose-300">
            <AlertCircle size={13} /> Drop-in tool load errors
          </div>
          <ul className="space-y-1 text-xs text-fg-muted">
            {data.errors
              .filter((e) => e.kind === "tool")
              .map((e, i) => (
                <li key={`${e.file}-${i}`}>
                  <span className="font-mono">{e.file}</span>: {e.error}
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function DropInToolRow({
  tool,
  onSaved,
}: {
  tool: ExternalToolInfo;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(tool.secrets.map((s) => [s.key, s.is_set ? SECRET_MASK : ""])),
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setValues(
      Object.fromEntries(tool.secrets.map((s) => [s.key, s.is_set ? SECRET_MASK : ""])),
    );
  }, [tool.name, tool.secrets]);

  const hasSecrets = tool.secrets.length > 0;
  const setCount = tool.secrets.filter((s) => s.is_set).length;
  const requiredMissing = tool.secrets.some((s) => s.required && !s.is_set);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const payload: Record<string, string> = {};
      for (const s of tool.secrets) {
        const v = values[s.key];
        if (v === undefined) continue;
        if (v === SECRET_MASK) continue;
        payload[s.key] = v;
      }
      await api.extensions.saveToolSecrets(tool.name, payload);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-fg">{tool.name}</span>
            {tool.category && (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border bg-surface-3 text-fg-subtle border-border">
                {tool.category}
              </span>
            )}
            {hasSecrets && (
              <span
                className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${
                  requiredMissing
                    ? "bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-900"
                    : "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900"
                }`}
              >
                {setCount}/{tool.secrets.length} secrets
              </span>
            )}
          </div>
          {tool.description && (
            <p className="text-xs text-fg-muted mt-0.5 line-clamp-2">{tool.description}</p>
          )}
          {tool.file && (
            <p className="text-[11px] text-fg-faint mt-0.5 font-mono truncate">{tool.file}</p>
          )}
        </div>
        {hasSecrets && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors shrink-0"
          >
            <KeyRound size={13} /> {open ? "Hide" : "Edit"}
          </button>
        )}
      </div>

      {open && hasSecrets && (
        <div className="mt-2 pl-3 border-l border-border/60 space-y-2">
          {tool.secrets.map((s) => (
            <label key={s.key} className="block">
              <span className="text-xs text-fg-subtle">
                {s.label ?? s.key}
                {s.required && <span className="text-rose-600 dark:text-rose-400 ml-0.5">*</span>}
              </span>
              {s.description && (
                <span className="block text-[11px] text-fg-faint">{s.description}</span>
              )}
              <input
                type="password"
                autoComplete="off"
                value={values[s.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [s.key]: e.target.value }))}
                onFocus={(e) => {
                  if (e.currentTarget.value === SECRET_MASK) e.currentTarget.select();
                }}
                placeholder={s.is_set ? "" : "not configured"}
                className="mt-0.5 w-full px-2 py-1 text-sm bg-surface border border-border rounded font-mono"
              />
            </label>
          ))}
          {err && <p className="text-xs text-rose-700 dark:text-rose-400">{err}</p>}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => void save()}
              disabled={saving}
              className="text-xs px-2 py-1 rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <span className="text-[11px] text-fg-faint">
              Leave a field empty to clear it. Stored encrypted at rest.
            </span>
          </div>
        </div>
      )}
    </li>
  );
}
