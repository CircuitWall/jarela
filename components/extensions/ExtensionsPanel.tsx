"use client";
import { AlertCircle, Puzzle, RefreshCw, KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { ExtensionsListResponse, ToolSecretSlotInfo, ExternalToolInfo } from "@/api/types";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";

const SECRET_MASK = "********";

export function ExtensionsPanel() {
  const [data, setData] = useState<ExtensionsListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  useDeepLinkScroll("extensions", "extension", containerRef);

  async function load() {
    setLoading(true);
    try {
      setData(await api.extensions.list());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <Puzzle size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg mr-auto">Extensions</h2>
        <button
          onClick={() => void load()}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors"
          title="Re-scan extension directories"
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
        {loading && !data && (
          <p className="text-fg-faint text-sm py-6 text-center">Loading…</p>
        )}

        {data && (
          <>
            <Section title="External providers" dir={data.directories.providers}>
              {data.providers.length === 0 ? (
                <EmptyHint
                  dir={data.directories.providers}
                  what="provider"
                  template="lib/providers/template-external.cjs.example"
                />
              ) : (
                data.providers.map((p) => (
                  <Row key={p.name} name={p.name} file={p.file} />
                ))
              )}
            </Section>

            <Section title="External tools" dir={data.directories.tools}>
              {data.tools.length === 0 ? (
                <EmptyHint
                  dir={data.directories.tools}
                  what="tool"
                  template="lib/tools/template-external.cjs.example"
                />
              ) : (
                data.tools.map((t) => (
                  <ToolRow key={t.name} tool={t} onSaved={() => void load()} />
                ))
              )}
            </Section>

            {data.errors.length > 0 && (
              <Section title="Validation errors">
                {data.errors.map((e, i) => (
                  <div
                    key={`${e.kind}-${e.file}-${i}`}
                    className="flex gap-2 py-2 border-b border-border/60"
                  >
                    <AlertCircle
                      size={13}
                      className="text-rose-700 dark:text-rose-400 mt-0.5 shrink-0"
                    />
                    <div className="min-w-0">
                      <p className="text-xs text-fg">
                        <span className="text-fg-subtle uppercase tracking-wide">
                          {e.kind}
                        </span>{" "}
                        <span className="font-mono">{e.file}</span>
                      </p>
                      <p className="text-xs text-rose-700 dark:text-rose-400 break-words">
                        {e.error}
                      </p>
                    </div>
                  </div>
                ))}
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  dir,
  children,
}: {
  title: string;
  dir?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-baseline justify-between mb-1.5">
        <h3 className="text-[11px] uppercase tracking-wide text-fg-faint font-semibold">
          {title}
        </h3>
        {dir && (
          <span
            className="text-[10px] text-fg-faint font-mono truncate max-w-[60%]"
            title={dir}
          >
            {dir}
          </span>
        )}
      </div>
      <div>{children}</div>
    </section>
  );
}

function Row({
  name,
  file,
  badge,
  sub,
}: {
  name: string;
  file: string | null;
  badge?: string;
  sub?: string;
}) {
  return (
    <div data-deep-link-id={name} className="flex items-center gap-3 py-2 border-b border-border/60">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-fg">{name}</span>
          {badge && (
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border bg-surface-2 text-fg-subtle border-border">
              {badge}
            </span>
          )}
        </div>
        {sub && (
          <p className="text-xs text-fg-faint mt-0.5 line-clamp-2">{sub}</p>
        )}
        {file && (
          <p className="text-[11px] text-fg-faint mt-0.5 font-mono truncate">
            {file}
          </p>
        )}
      </div>
    </div>
  );
}

function ToolRow({
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

  // If the panel re-fetches and the slot set changes, reset the editor.
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
        if (v === SECRET_MASK) continue; // leave untouched
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
    <div data-deep-link-id={tool.name} className="py-2 border-b border-border/60">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg">{tool.name}</span>
            {tool.category && (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border bg-surface-2 text-fg-subtle border-border">
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
                title={requiredMissing ? "Required secrets are missing" : "Configured"}
              >
                {setCount}/{tool.secrets.length} secrets
              </span>
            )}
          </div>
          {tool.description && (
            <p className="text-xs text-fg-faint mt-0.5 line-clamp-2">{tool.description}</p>
          )}
          {tool.file && (
            <p className="text-[11px] text-fg-faint mt-0.5 font-mono truncate">{tool.file}</p>
          )}
        </div>
        {hasSecrets && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors shrink-0"
            title="Edit secrets"
          >
            <KeyRound size={13} /> {open ? "Hide" : "Edit"}
          </button>
        )}
      </div>

      {open && hasSecrets && (
        <div className="mt-2 ml-1 pl-3 border-l border-border/60 space-y-2">
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
                onChange={(e) =>
                  setValues((v) => ({ ...v, [s.key]: e.target.value }))
                }
                onFocus={(e) => {
                  if (e.currentTarget.value === SECRET_MASK) {
                    e.currentTarget.select();
                  }
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
    </div>
  );
}

function EmptyHint({
  dir,
  what,
  template,
}: {
  dir: string;
  what: "provider" | "tool";
  template: string;
}) {
  return (
    <div className="text-fg-faint text-xs py-4 space-y-1.5">
      <p>No external {what}s loaded.</p>
      <p>
        Drop a <code className="text-fg-subtle">.cjs</code> file into{" "}
        <span className="font-mono text-fg-subtle">{dir}</span>. Hot-reload is
        automatic on the next request.
      </p>
      <p>
        Template: <span className="font-mono text-fg-subtle">{template}</span>
      </p>
    </div>
  );
}
