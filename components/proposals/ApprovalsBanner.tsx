"use client";
import { Check, ChevronDown, ChevronUp, ShieldAlert, X } from "lucide-react";
import { useMemo, useState, useEffect, useRef, useId } from "react";
import { api } from "@/api/client";
import type { IntegrationDefinition, PendingAction } from "@/api/types";
import { pushToast } from "@/lib/ui/toasts";
import { errorMessage } from "@/lib/utils/error";
import { choiceProposalSchema, choiceResponseSchema } from "@/lib/proposals/choice";
import { ChoiceFields, type ChoiceResponse } from "./ChoiceFields";
import { ArtifactPreview } from "./ArtifactPreview";

const PAYLOAD_PREVIEW_CHARS = 6_000;
const PAYLOAD_EXPANDED_PREVIEW_CHARS = 20_000;
const PAYLOAD_PREVIEW_MAX_DEPTH = 8;
const PAYLOAD_PREVIEW_MAX_ENTRIES = 120;
const PAYLOAD_PREVIEW_STRING_CHARS = 1_000;

export interface PayloadPreviewResult {
  text: string;
  truncated: boolean;
}

export function formatPayloadPreview(
  payload: unknown,
  opts: {
    maxChars?: number;
    maxDepth?: number;
    maxEntries?: number;
    maxStringChars?: number;
  } = {},
): PayloadPreviewResult {
  const maxChars = opts.maxChars ?? PAYLOAD_PREVIEW_CHARS;
  const maxDepth = opts.maxDepth ?? PAYLOAD_PREVIEW_MAX_DEPTH;
  const maxEntries = opts.maxEntries ?? PAYLOAD_PREVIEW_MAX_ENTRIES;
  const maxStringChars = opts.maxStringChars ?? PAYLOAD_PREVIEW_STRING_CHARS;
  const seen = new WeakSet<object>();
  let out = "";
  let truncated = false;

  const append = (s: string) => {
    if (out.length >= maxChars) {
      truncated = true;
      return false;
    }
    const room = maxChars - out.length;
    if (s.length > room) {
      out += s.slice(0, room);
      truncated = true;
      return false;
    }
    out += s;
    return true;
  };

  const writeIndent = (level: number) => append("  ".repeat(level));
  const writeString = (value: string) => {
    if (value.length > maxStringChars) {
      truncated = true;
      return append(JSON.stringify(`${value.slice(0, maxStringChars)}… (${value.length - maxStringChars} more chars)`));
    }
    return append(JSON.stringify(value));
  };

  const writeValue = (value: unknown, depth: number): boolean => {
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      return append(JSON.stringify(value));
    }
    if (typeof value === "string") return writeString(value);
    if (typeof value === "undefined") return append(JSON.stringify("[undefined]"));
    if (typeof value === "function" || typeof value === "symbol") return writeString(`[${typeof value}]`);
    if (typeof value !== "object") return writeString(String(value));
    if (seen.has(value)) {
      truncated = true;
      return writeString("[Circular]");
    }
    if (depth >= maxDepth) {
      truncated = true;
      return writeString("[Max depth reached]");
    }

    seen.add(value);
    if (Array.isArray(value)) {
      if (!append("[")) return false;
      const count = Math.min(value.length, maxEntries);
      for (let i = 0; i < count; i++) {
        if (!append(i === 0 ? "\n" : ",\n")) return false;
        if (!writeIndent(depth + 1)) return false;
        if (!writeValue(value[i], depth + 1)) return false;
      }
      if (value.length > count) {
        truncated = true;
        if (!append(count === 0 ? "\n" : ",\n")) return false;
        if (!writeIndent(depth + 1)) return false;
        if (!writeString(`… ${value.length - count} more items`)) return false;
      }
      if (count > 0 || value.length > count) {
        if (!append("\n")) return false;
        if (!writeIndent(depth)) return false;
      }
      return append("]");
    }

    const entries = Object.entries(value as Record<string, unknown>);
    if (!append("{")) return false;
    const count = Math.min(entries.length, maxEntries);
    for (let i = 0; i < count; i++) {
      const [key, val] = entries[i];
      if (!append(i === 0 ? "\n" : ",\n")) return false;
      if (!writeIndent(depth + 1)) return false;
      if (!writeString(key) || !append(": ")) return false;
      if (!writeValue(val, depth + 1)) return false;
    }
    if (entries.length > count) {
      truncated = true;
      if (!append(count === 0 ? "\n" : ",\n")) return false;
      if (!writeIndent(depth + 1)) return false;
      if (!writeString("…") || !append(": ") || !writeString(`${entries.length - count} more keys`)) return false;
    }
    if (count > 0 || entries.length > count) {
      if (!append("\n")) return false;
      if (!writeIndent(depth)) return false;
    }
    return append("}");
  };

  writeValue(payload, 0);
  if (truncated && out.length < maxChars) out += "\n… preview truncated";
  else if (truncated) out = `${out}\n… preview truncated`;
  return { text: out, truncated };
}

// Compute the deep-link URL + label for a successfully-approved action so
// the resulting toast lets the user jump to the row that just changed.
// Returns null for kinds without a sensible settings target.
function approvalToastTarget(action: PendingAction): { href: string; hrefLabel: string; title: string } | null {
  const p = action.payload as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  switch (action.kind) {
    case "enable_integration": {
      const id = str("id");
      return id ? { href: `?tab=credentials&item=${encodeURIComponent(id)}`, hrefLabel: "Open in Credentials →", title: `${id} enabled` } : null;
    }
    case "start_oauth": {
      const id = str("integration_id");
      return id ? { href: `?tab=credentials&item=${encodeURIComponent(id)}`, hrefLabel: "Open in Credentials →", title: `${id} authorized` } : null;
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
    case "enable_tool_category":
    case "enable_dropin_tool": {
      const name = str("category") ?? str("name");
      return name ? { href: `?tab=tools&item=${encodeURIComponent(name)}`, hrefLabel: "Open Tools →", title: "Tool permission enabled" } : null;
    }
    case "upsert_harness": {
      // Prefer the harness id from the apply result (creates assign a fresh
      // custom:<uuid>); fall back to the payload id for edits.
      const result = (action.result ?? null) as Record<string, unknown> | null;
      const resultId = result && typeof result["id"] === "string" ? (result["id"] as string) : undefined;
      const id = resultId ?? str("id");
      return id ? { href: `?tab=harness&item=${encodeURIComponent(id)}`, hrefLabel: "Open in Harness →", title: "Harness saved" } : { href: "?tab=harness", hrefLabel: "Open Harness →", title: "Harness saved" };
    }
    case "write_skill":
      return { href: "?tab=skills", hrefLabel: "Open Skills →", title: "Skill saved" };
    case "update_scheduled_task_prompt":
    case "update_watcher_prompt":
      return { href: "?tab=tasks", hrefLabel: "Open Tasks →", title: "Prompt updated" };
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
  onResolved,
}: {
  agentId: string | null;
  onChange?: () => void;
  onResolved?: (action: PendingAction) => Promise<void>;
}) {
  const [pending, setPending] = useState<PendingAction[]>([]);
  const requestsId = useId();
  const [open, setOpen] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [secretForm, setSecretForm] = useState<SecretFormState | null>(null);
  const [responses, setResponses] = useState<Record<string, ChoiceResponse>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [outcomes, setOutcomes] = useState<Record<string, PendingAction>>({});
  const settledIds = useRef(new Set<string>());
  const currentAgent = useRef(agentId);
  currentAgent.current = agentId;

  async function refresh() {
    try {
      const all = await api.pending.list("pending");
      if (currentAgent.current !== agentId) return;
      const filtered = all.filter((action) => !settledIds.current.has(action.id)
        && (!agentId || action.agent_id === agentId));
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

  async function continueConversation(action: PendingAction) {
    if (!onResolved) return;
    markBusy(action.id, true);
    try {
      await onResolved(action);
      setErrors((previous) => ({ ...previous, [action.id]: "" }));
    } catch (error) {
      setErrors((previous) => ({
        ...previous, [action.id]: `Outcome saved, but chat could not continue: ${errorMessage(error)}`,
      }));
    } finally { markBusy(action.id, false); }
  }

  async function recordOutcome(action: PendingAction) {
    settledIds.current.add(action.id);
    setOutcomes((previous) => ({ ...previous, [action.id]: action }));
    setPending((previous) => previous.filter((item) => item.id !== action.id));
    if (action.status === "failed") {
      setErrors((previous) => ({
        ...previous, [action.id]: typeof action.result === "string" ? action.result : "Proposal failed to apply; check its status.",
      }));
    } else {
      await continueConversation(action);
    }
    onChange?.();
  }

  // Approve flow for kinds whose payload contains no secrets and no follow-up.
  async function plainApprove(action: PendingAction) {
    markBusy(action.id, true);
    try {
      const result = await api.pending.approve(action.id, action.kind === "ask_choice"
        ? { ...responses[action.id] }
        : undefined);
      if (result.status === "approved") pushApprovalToast(result);
      await recordOutcome(result);
    } catch (e) {
      setErrors((previous) => ({ ...previous, [action.id]: errorMessage(e) }));
    }
    finally { markBusy(action.id, false); }
  }

  async function deny(action: PendingAction) {
    markBusy(action.id, true);
    try {
      const result = await api.pending.deny(action.id);
      await recordOutcome(result);
    } catch (error) {
      setErrors((previous) => ({ ...previous, [action.id]: errorMessage(error) }));
    }
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
      const result = await api.pending.approve(action.id);
      if (result.status !== "approved") {
        await recordOutcome(result);
        return;
      }
      let resp: { authorize_url: string } | null = null;
      if (integrationId === "gmail") resp = await api.integrations.gmailOauthStart({});
      else if (integrationId === "outlook") resp = await api.integrations.outlookOauthStart({});
      if (resp?.authorize_url) window.open(resp.authorize_url, "_blank", "noopener,noreferrer");
      pushApprovalToast(result);
      await recordOutcome(result);
    } catch (error) {
      setErrors((previous) => ({ ...previous, [action.id]: errorMessage(error) }));
    }
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
      const result = await api.pending.approve(secretForm.action.id, extras);
      if (result.status === "approved") pushApprovalToast(result);
      setSecretForm(null);
      await recordOutcome(result);
    } catch (e) {
      setSecretForm({
        ...secretForm,
        submitting: false,
        error: errorMessage(e),
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

  const visiblePending = pending.filter((action) => !outcomes[action.id]
    && (!agentId || action.agent_id === agentId));
  const visibleOutcomes = Object.values(outcomes).filter((action) => !agentId || action.agent_id === agentId);
  if (visiblePending.length === 0 && visibleOutcomes.length === 0 && !secretForm) return null;

  return (
    <>
      {visibleOutcomes.map((action) => (
        <div key={action.id} className="mx-4 mb-2 rounded-lg border border-border bg-surface-2 p-3 text-xs text-fg">
          <p role="status">{action.kind === "ask_choice"
            ? action.status === "approved" ? "Response recorded" : action.status === "failed" ? "Response failed" : "Question dismissed"
            : action.status === "approved" ? "Change applied" : action.status === "denied" ? "Change denied" : "Change failed"}</p>
          {errors[action.id] && <p role="alert" className="my-1 text-red-500">{errors[action.id]}</p>}
          {errors[action.id] && action.status !== "failed" && onResolved && (
            <button disabled={busyIds.has(action.id)} onClick={() => void continueConversation(action)} className="mr-3 underline">
              Retry chat continuation
            </button>
          )}
          <button onClick={() => setOutcomes((previous) => {
            const next = { ...previous };
            delete next[action.id];
            return next;
          })} className="underline">Dismiss result</button>
        </div>
      ))}
      {visiblePending.length > 0 && (
        <div className="mx-4 mb-2 rounded-lg border border-amber-700/60 bg-amber-950/30 overflow-hidden">
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={requestsId}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 hover:bg-amber-900/20 transition-colors"
          >
            <ShieldAlert size={13} className="text-amber-700 dark:text-amber-400 shrink-0" />
            <span className="font-medium">
              {visiblePending.some((action) => action.kind === "ask_choice")
                ? `${visiblePending.length} ${visiblePending.length === 1 ? "request" : "requests"} awaiting your response`
                : `${visiblePending.length} ${visiblePending.length === 1 ? "change" : "changes"} awaiting your approval`}
            </span>
            <span className="ml-auto opacity-70">{open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</span>
          </button>

          {open && (
            <div id={requestsId} className="max-h-[50dvh] overflow-y-auto border-t border-amber-700/40 divide-y divide-amber-700/30">
              {visiblePending.map((a) => {
                const busy = busyIds.has(a.id);
                const choice = a.kind === "ask_choice" ? choiceProposalSchema.safeParse(a.payload) : null;
                const response = responses[a.id] ?? { selected_values: [] };
                const validResponse = choice?.success
                  ? choiceResponseSchema(choice.data).safeParse(response).success
                  : a.kind !== "ask_choice";
                return (
                  <div key={a.id} className="px-3 py-2.5 text-xs">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono uppercase tracking-wide text-[10px] text-amber-700 dark:text-amber-400/80">{a.kind}</span>
                      {a.reason && <span className="text-fg">{a.reason}</span>}
                    </div>
                    {choice?.success ? (
                      <ChoiceFields
                        proposal={choice.data}
                        response={response}
                        onChange={(value) => setResponses((previous) => ({ ...previous, [a.id]: value }))}
                        disabled={busy}
                      />
                    ) : a.kind === "write_skill" || a.kind === "update_scheduled_task_prompt" || a.kind === "update_watcher_prompt"
                      ? <ArtifactPreview payload={a.payload} />
                      : <PayloadPreview payload={a.payload} />}
                    {choice && !choice.success && <p role="alert">Invalid choice proposal. Dismiss it and request a new question.</p>}
                    {errors[a.id] && <p role="alert" className="text-red-500">{errors[a.id]}</p>}
                    <div className="flex gap-1.5 justify-end">
                      <button
                        onClick={() => deny(a)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-fg-subtle hover:text-fg hover:border-fg-faint disabled:opacity-50"
                      >
                        <X size={11} /> {a.kind === "ask_choice" ? "Dismiss" : "Deny"}
                      </button>
                      <button
                        onClick={() => approve(a)}
                        disabled={busy || !validResponse}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-50"
                      >
                        <Check size={11} /> {busy ? "Submitting…" : a.kind === "ask_choice" ? "Submit response" : "Approve"}
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
          <PayloadPreview payload={state.action.payload} subtle />
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

function PayloadPreview({ payload, subtle = false }: { payload: unknown; subtle?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const preview = useMemo(
    () => formatPayloadPreview(payload, {
      maxChars: expanded ? PAYLOAD_EXPANDED_PREVIEW_CHARS : PAYLOAD_PREVIEW_CHARS,
    }),
    [expanded, payload],
  );

  async function copyFullPayload() {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  const preClass = subtle
    ? "text-[11px] text-fg-subtle font-mono whitespace-pre-wrap break-words bg-surface rounded p-2 border border-border max-h-72 overflow-auto"
    : "text-[11px] text-amber-800 dark:text-amber-200/70 font-mono whitespace-pre-wrap break-words bg-amber-950/40 rounded p-2 mb-2 max-h-56 overflow-auto";

  return (
    <div className={subtle ? "space-y-1" : "mb-2 space-y-1"}>
      <pre className={preClass}>{preview.text}</pre>
      {preview.truncated && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-faint">
          <span>
            Large proposal payload truncated for chat performance.
          </span>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="underline underline-offset-2 hover:text-fg"
          >
            {expanded ? "Show shorter preview" : "Show larger preview"}
          </button>
          <button
            type="button"
            onClick={() => { void copyFullPayload(); }}
            className="underline underline-offset-2 hover:text-fg"
          >
            {copied ? "Copied" : "Copy full JSON"}
          </button>
        </div>
      )}
    </div>
  );
}
