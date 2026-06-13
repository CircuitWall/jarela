"use client";
import { useEffect, useState } from "react";
import { Plug, AlertCircle } from "lucide-react";
import { api } from "@/api/client";
import type { ExtensionsListResponse } from "@/api/types";
import { pushErrorToast } from "@/lib/ui/error-report";

// Drop-in CJS provider definitions hot-loaded from `$JARELA_PROVIDERS_DIR`.
// These augment the built-in provider list (Anthropic, OpenAI, etc.)
// without a rebuild. Read-only listing — operators edit by dropping a
// `.cjs` file in the directory.
export function CustomProvidersSection() {
  const [data, setData] = useState<ExtensionsListResponse | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      setData(await api.extensions.list());
    } catch (e) {
      pushErrorToast({
        title: "Couldn't load custom providers",
        error: e,
        context: { panel: "models", action: "list-custom-providers" },
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const providers = data?.providers ?? [];
  const errors = data?.errors.filter((e) => e.kind === "provider") ?? [];

  return (
    <section className="px-4 py-4 border-t border-border space-y-2">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Plug size={13} className="text-fg-faint" />
          <h3 className="text-sm font-semibold text-fg">Custom providers</h3>
        </div>
        <p className="text-xs text-fg-faint">
          Drop a <code className="font-mono text-[11px]">.cjs</code> file into{" "}
          <span className="font-mono">{data?.directories.providers ?? "$JARELA_PROVIDERS_DIR"}</span>{" "}
          to register an LLM provider without a rebuild. Template:{" "}
          <code className="font-mono text-[11px]">lib/providers/template-external.cjs.example</code>.
        </p>
      </header>

      {loading && !data && (
        <p className="text-fg-faint text-sm py-2 text-center">Loading…</p>
      )}

      {data && providers.length === 0 && (
        <p className="text-xs text-fg-faint py-2">No custom providers loaded.</p>
      )}

      {providers.length > 0 && (
        <ul className="space-y-1">
          {providers.map((p) => (
            <li
              key={p.name}
              className="flex items-center gap-3 py-1.5 border-b border-border/60"
            >
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-fg">{p.name}</span>
                {p.file && (
                  <p className="text-[11px] text-fg-faint mt-0.5 font-mono truncate">
                    {p.file}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {errors.length > 0 && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2.5 space-y-1 mt-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-rose-800 dark:text-rose-300">
            <AlertCircle size={13} /> Provider load errors
          </div>
          <ul className="space-y-1 text-xs text-fg-muted">
            {errors.map((e, i) => (
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
