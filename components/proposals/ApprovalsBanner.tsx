"use client";
import { Check, ChevronDown, ChevronUp, ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { IntegrationDefinition, PendingAction } from "@/api/types";
import { pushToast } from "@/lib/ui/toasts";

// Compute the deep-link URL + label for a successfully-approved action so
// the resulting toast lets the user jump to the row that just changed.
// Returns null for kinds without a sensible settings target.
function approvalToastTarget(action: PendingAction): { href: string; hrefLabel: string; title: string } | null {
  const p = action.payload as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  switch (action.kind) {
    case "enable_integration": {
      const id = str("id");
      return id ? { href: `?tab=credentials&item=integrations`, hrefLabel: "Open in Credentials →", title: `${id} enabled` } : null;
    }
    case "start_oauth": {
      const id = str("integration_id");
      return id ? { href: `?tab=credentials&item=integrations`, hrefLabel: "Open in Credentials →", title: `${id} authorized` } : null;
    }
    case "set_provider_key": {
      const name = str("name") ?? str("provider");
      return name ? { href: `?tab=models&item=${encodeURIComponent(name)}`, hrefLabel: "Open in Models →", title: `${name} key saved` } : null;
    }
    case "install_mcp":
    case "toggle_mcp": {
      const name = str("name") ?? str("registry_id");
      return name ? { href: `?tab=mcp&item=${encodeURIComponent(name)}`, hrefLabel: "Open in MCP →", title: `MCP server ${action.kind === "install_mcp" ? "installed" : "updated"}` } : null;
    }
    case "update_agent":
    case "update_agent_tools": {
      const id = str("agent_id");
      return id ? { href: `?tab=agents&item=${encodeURIComponent(id)}`, hrefLabel: "Open agent →", title: "Agent updated" } : null;
    }
    case "upsert_harness": {
      // Prefer the harness id from the apply result (creates assign a fresh
      // custom:<uuid>); fall back to the payload id for edits.
      const result = (action.result ?? null) as Record<string, unknown> | null;
      const resultId = result && typeof result["id"] === "string" ? (result["id"] as string) : undefined;
      const id = resultId ?? str("id");
      return id ? { href: `?tab=harness&item=${encodeURIComponent(id)}`, hrefLabel: "Open in Harness →", title: "Harness saved" } : { href: "?tab=harness", hrefLabel: "Open Harness →", title: "Harness saved" };
    }
    default:
      return null;
  }
}

function pushApprovalToast(action: PendingAction) {
  const t = approvalToastTarget(action);
  if (!t) return;
  pushToast({
    kind: "success",
    source: "system",
    sourceLabel: "Setup",
    title: t.title,
    body: action.reason ?? "Change applied.",
    agent_id: action.agent_id ?? null,
    thread_id: null,
    href: t.href,
    hrefLabel: t.hrefLabel,
    ttl: 8000,
  });
}

// A small banner that appears above the input bar whenever the agent has
// queued one or more proposals for the user's approval. Each row shows
// what the change is + the agent's reason + approve/deny buttons.
//
// Polled every 4s and on tab visibility change. We could subscribe via
// /api/v1/events instead, but the load is trivial and polling avoids one
// more SSE stream from leaking memory if the component unmounts.
//
// ADR-0010 kinds (`set_provider_key`, `enable_integration`, `start_oauth`)
// require user-side material the agent never sees — Approve opens a small
// secret-collection modal whose values ride to the server in `extras` and
// (for OAuth) trigger a window.open to the vendor consent screen.

type SecretFormState = {
  action: PendingAction;
  fields: Array<{ key: string; label: string; secret: boolean; required: boolean; placeholder?: string }>;
  values: Record<string, string>;
  submitting: boolean;
  error: string | null;
};

export function ApprovalsBanner({
  agentId,
  onChange,
}: {
  agentId: string | null;
  onChange?: () => void;
}) {
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [open, setOpen] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [secretForm, setSecretForm] = useState<SecretFormState | null>(null);

  async function refresh() {
    try {
      const all = await api.pending.list("pending");
      const filtered = agentId ? all.filter((a) => a.agent_id === agentId) : all;
      setPending(filtered);
    } catch (e) { console.error(e); }
  }

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 4000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  function markBusy(id: string, busy: boolean) {
    setBusyIds((p) => {
      const n = new Set(p);
      if (busy) n.add(id); else n.delete(id);
      return n;
    });
  }

  // Approve flow for kinds whose payload contains no secrets and no follow-up.
  async function plainApprove(action: PendingAction) {
    markBusy(action.id, true);
    try {
      await api.pending.approve(action.id);
      pushApprovalToast(action);
      await refresh();
      onChange?.();
    } catch (e) { console.error(e); }
    finally { markBusy(action.id, false); }
  }

  async function deny(action: PendingAction) {
    markBusy(action.id, true);
    try {
      await api.pending.deny(action.id);
      await refresh();
      onChange?.();
    } catch (e) { console.error(e); }
    finally { markBusy(action.id, false); }
  }

  // Approve a `start_oauth` proposal: the apply step returns a kickoff_path
  // and we have to actually open the vendor authorize URL. Today both gmail
  // and outlook expose dedicated start endpoints — we dispatch on
  // integration_id rather than blindly POSTing to kickoff_path so the typed
  // API client stays the contract.
  async function approveStartOauth(action: PendingAction) {
    const integrationId = (action.payload as { integration_id?: string }).integration_id;
    markBusy(action.id, true);
    try {
      await api.pending.approve(action.id);
      let resp: { authorize_url: string } | null = null;
      if (integrationId === "gmail") resp = await api.integrations.gmailOauthStart({});
      else if (integrationId === "outlook") resp = await api.integrations.outlookOauthStart({});
      if (resp?.authorize_url) window.open(resp.authorize_url, "_blank", "noopener,noreferrer");
      pushApprovalToast(action);
      await refresh();
      onChange?.();
    } catch (e) { console.error(e); }
    finally { markBusy(action.id, false); }
  }

  // For `set_provider_key`, schema is fixed: api_key (secret, required) plus
  // optional base_url for self-hosted endpoints. We don't ship the agent's
  // declared `is_default`/`provider`/`model_id` here — those rode in via the
  // payload and the server reads them from the action row.
  function openProviderKeyModal(action: PendingAction) {
    setSecretForm({
      action,
      fields: [
        { key: "api_key", label: "API key", secret: true, required: true, placeholder: "sk-…" },
        { key: "base_url", label: "Base URL (optional)", secret: false, required: false, placeholder: "https://…" },
      ],
      values: {},
      submitting: false,
      error: null,
    });
  }

  // For `enable_integration`, fields come from the credentials schema the
  // server already advertises. Fetch on open rather than caching — the list
  // is small and the modal stays mounted only while the user fills it.
  async function openIntegrationModal(action: PendingAction) {
    const integrationId = (action.payload as { id?: string }).id;
    if (!integrationId) return;
    markBusy(action.id, true);
    try {
      const list = await api.integrations.list();
      const def = list.definitions.find((d: IntegrationDefinition) => d.name === integrationId);
      if (!def) {
        await deny(action);
        return;
      }
      setSecretForm({
        action,
        fields: def.fields.map((f) => ({
          key: f.key,
          label: f.label,
          secret: f.secret,
          required: f.required,
          placeholder: f.placeholder,
        })),
        values: {},
        submitting: false,
        error: null,
      });
    } catch (e) { console.error(e); }
    finally { markBusy(action.id, false); }
  }

  async function submitSecretForm() {
    if (!secretForm) return;
    const missing = secretForm.fields
      .filter((f) => f.required && !secretForm.values[f.key]?.trim())
      .map((f) => f.label);
    if (missing.length > 0) {
      setSecretForm({ ...secretForm, error: `Required: ${missing.join(", ")}` });
      return;
    }
    setSecretForm({ ...secretForm, submitting: true, error: null });
    try {
      const extras: Record<string, string> = {};
      for (const [k, v] of Object.entries(secretForm.values)) {
        if (typeof v === "string" && v.trim()) extras[k] = v.trim();
      }
      await api.pending.approve(secretForm.action.id, extras);
      pushApprovalToast(secretForm.action);
      setSecretForm(null);
      await refresh();
      onChange?.();
    } catch (e) {
      setSecretForm({
        ...secretForm,
        submitting: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  function approve(action: PendingAction) {
    switch (action.kind) {
      case "set_provider_key":   return openProviderKeyModal(action);
      case "enable_integration": return openIntegrationModal(action);
      case "start_oauth":        return approveStartOauth(action);
      default:                   return plainApprove(action);
    }
  }

  if (pending.length === 0 && !secretForm) return null;

  return (
    <>
      {pending.length > 0 && (
        <div className="mx-4 mb-2 rounded-lg border border-amber-700/60 bg-amber-950/30 overflow-hidden">
          <button
            onClick={() => setOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 hover:bg-amber-900/20 transition-colors"
          >
            <ShieldAlert size={13} className="text-amber-700 dark:text-amber-400 shrink-0" />
            <span className="font-medium">
              {pending.length} {pending.length === 1 ? "change" : "changes"} awaiting your approval
            </span>
            <span className="ml-auto opacity-70">{open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</span>
          </button>

          {open && (
            <div className="border-t border-amber-700/40 divide-y divide-amber-700/30">
              {pending.map((a) => {
                const busy = busyIds.has(a.id);
                return (
                  <div key={a.id} className="px-3 py-2.5 text-xs">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono uppercase tracking-wide text-[10px] text-amber-700 dark:text-amber-400/80">{a.kind}</span>
                      {a.reason && <span className="text-amber-100/90">{a.reason}</span>}
                    </div>
                    <pre className="text-[11px] text-amber-800 dark:text-amber-200/70 font-mono whitespace-pre-wrap break-words bg-amber-950/40 rounded p-2 mb-2">
                      {JSON.stringify(a.payload, null, 2)}
                    </pre>
                    <div className="flex gap-1.5 justify-end">
                      <button
                        onClick={() => deny(a)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-fg-subtle hover:text-fg hover:border-fg-faint disabled:opacity-50"
                      >
                        <X size={11} /> Deny
                      </button>
                      <button
                        onClick={() => approve(a)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-50"
                      >
                        <Check size={11} /> {busy ? "Applying…" : "Approve"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {secretForm && (
        <SecretFormModal
          state={secretForm}
          onChangeValue={(key, val) =>
            setSecretForm({ ...secretForm, values: { ...secretForm.values, [key]: val } })
          }
          onCancel={() => setSecretForm(null)}
          onSubmit={() => void submitSecretForm()}
        />
      )}
    </>
  );
}

function SecretFormModal({
  state,
  onChangeValue,
  onCancel,
  onSubmit,
}: {
  state: SecretFormState;
  onChangeValue: (key: string, val: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const title =
    state.action.kind === "set_provider_key"
      ? "Provide API key"
      : state.action.kind === "enable_integration"
        ? "Enable integration"
        : "Provide credentials";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface-2 shadow-xl">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">{title}</h2>
          {state.action.reason && (
            <p className="text-xs text-fg-subtle mt-1">{state.action.reason}</p>
          )}
        </div>
        <div className="p-4 space-y-3">
          <pre className="text-[11px] text-fg-subtle font-mono whitespace-pre-wrap break-words bg-surface rounded p-2 border border-border">
            {JSON.stringify(state.action.payload, null, 2)}
          </pre>
          {state.fields.map((f) => (
            <div key={f.key} className="space-y-1">
              <label htmlFor={`sec-${f.key}`} className="text-xs font-medium text-fg-subtle">
                {f.label}{f.required ? " *" : ""}
              </label>
              <input
                id={`sec-${f.key}`}
                type={f.secret ? "password" : "text"}
                value={state.values[f.key] ?? ""}
                onChange={(e) => onChangeValue(f.key, e.target.value)}
                placeholder={f.placeholder}
                autoComplete="off"
                spellCheck={false}
                className="w-full px-3 py-2 rounded border border-border bg-surface text-fg placeholder:text-fg-faint focus:border-emerald-500 focus:outline-none text-sm font-mono"
              />
            </div>
          ))}
          {state.error && (
            <div className="rounded p-2 text-xs border border-rose-700/50 bg-rose-950/30 text-rose-300">
              {state.error}
            </div>
          )}
          <p className="text-[11px] text-fg-faint">
            Sent only to your local Jarela database (encrypted at rest). The agent never sees these values.
          </p>
        </div>
        <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={state.submitting}
            className="px-3 py-1.5 text-xs rounded border border-border text-fg-subtle hover:text-fg hover:border-fg-faint disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={state.submitting}
            className="px-3 py-1.5 text-xs rounded bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-50"
          >
            {state.submitting ? "Saving…" : "Approve and save"}
          </button>
        </div>
      </div>
    </div>
  );
}
