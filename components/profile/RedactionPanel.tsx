"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, ShieldCheck } from "lucide-react";

// RedactionPanel — settings UI for ADR-0064 outbound redaction.
// Surfaces the global on/off toggle, the path of the user's pattern
// file, and a read-only view of the patterns the app is currently
// using (defaults until the user materializes their own file).

interface PatternConfig {
  name: string;
  type_hint: string;
  validator?: string;
  enabled: boolean;
}

interface ActiveConfig {
  patterns: PatternConfig[];
  heuristics: {
    high_entropy: {
      enabled: boolean;
      min_length: number;
      min_entropy: number;
    };
  };
  field_name_allowlist: string[];
}

interface RedactionState {
  enabled: boolean;
  config_path: string;
  config_exists: boolean;
  active: ActiveConfig;
}

export function RedactionPanel() {
  const [state, setState] = useState<RedactionState | null>(null);
  const [showPatterns, setShowPatterns] = useState(false);
  const [showAllowlist, setShowAllowlist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/redaction");
      if (res.ok) setState(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/v1/redaction", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        await refresh();
      } else {
        setMsg("Could not save toggle.");
      }
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const materialize = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/v1/redaction/init", { method: "POST" });
      if (res.ok) {
        const { created, path } = (await res.json()) as { created: boolean; path: string };
        setMsg(created ? `Created ${path}` : `Already exists at ${path}`);
        await refresh();
      } else {
        setMsg("Could not create pattern file.");
      }
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (!state) {
    return (
      <div className="rounded-xl border border-border bg-surface-2/70 p-4 text-sm text-fg-muted">
        Loading redaction settings…
      </div>
    );
  }

  const enabledPatterns = state.active.patterns.filter((p) => p.enabled);

  return (
    <div className="rounded-xl border border-border bg-surface-2/70 p-4">
      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck size={14} className="text-emerald-500" />
        <h3 className="text-sm font-semibold text-fg">Outbound redaction</h3>
      </div>
      <p className="text-xs text-fg-muted mb-3">
        Sensitive values (API keys, JWTs, SSN, Swedish personnummer, IBAN, plus a
        high-entropy heuristic) are replaced with stable placeholders before being
        sent to the LLM, then rehydrated on the way back. Real values stay on this
        device.
      </p>

      <label className="flex items-center justify-between gap-2 py-2">
        <div className="flex flex-col">
          <span className="text-xs font-medium text-fg">Enable redaction</span>
          <span className="text-[11px] text-fg-faint">
            When off, message content reaches the LLM provider untouched.
          </span>
        </div>
        <input
          type="checkbox"
          checked={state.enabled}
          disabled={busy}
          onChange={(e) => void toggle(e.target.checked)}
          className="h-4 w-4 cursor-pointer accent-emerald-500"
        />
      </label>

      <div className="mt-2 pt-2 border-t border-border/50 flex items-center justify-between gap-2">
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-medium text-fg">Pattern file</span>
          <span className="text-[11px] text-fg-faint font-mono truncate" title={state.config_path}>
            {state.config_path}
          </span>
        </div>
        {state.config_exists ? (
          <span className="text-[11px] text-emerald-600 dark:text-emerald-400 shrink-0">
            user-edited
          </span>
        ) : (
          <button
            type="button"
            onClick={() => void materialize()}
            disabled={busy}
            className="text-[11px] px-2 py-1 rounded border border-border bg-surface-3 hover:bg-surface-2 text-fg disabled:opacity-50"
            title="Write the default pattern set to disk so you can edit it"
          >
            Create default file
          </button>
        )}
      </div>

      {msg && <div className="mt-2 text-[11px] text-fg-muted">{msg}</div>}

      <div className="mt-3 pt-2 border-t border-border/50">
        <button
          type="button"
          onClick={() => setShowPatterns((v) => !v)}
          className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
          aria-expanded={showPatterns}
        >
          <ChevronRight size={11} className={`transition-transform ${showPatterns ? "rotate-90" : ""}`} />
          <span>{enabledPatterns.length} active patterns</span>
          {state.active.heuristics.high_entropy.enabled && (
            <span className="text-fg-faint">
              {" "}+ entropy heuristic (≥ {state.active.heuristics.high_entropy.min_length} chars,
              ≥ {state.active.heuristics.high_entropy.min_entropy} bits/char)
            </span>
          )}
        </button>
        {showPatterns && (
          <ul className="mt-1 pl-4 space-y-0.5">
            {enabledPatterns.map((p) => (
              <li key={p.name} className="text-[11px] text-fg-muted">
                <span className="font-mono opacity-90">{p.name}</span>
                {" → "}
                <span className="font-mono opacity-75">{p.type_hint}</span>
                {p.validator && (
                  <span className="ml-1 text-fg-faint">[{p.validator}]</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-2">
        <button
          type="button"
          onClick={() => setShowAllowlist((v) => !v)}
          className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
          aria-expanded={showAllowlist}
        >
          <ChevronRight size={11} className={`transition-transform ${showAllowlist ? "rotate-90" : ""}`} />
          <span>{state.active.field_name_allowlist.length} allowlisted JSON field names</span>
        </button>
        {showAllowlist && (
          <div className="mt-1 pl-4 flex flex-wrap gap-1">
            {state.active.field_name_allowlist.map((f) => (
              <span
                key={f}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-3 text-fg-muted"
              >
                {f}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
