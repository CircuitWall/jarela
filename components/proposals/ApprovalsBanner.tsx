"use client";
import { Check, ChevronDown, ChevronUp, ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { PendingAction } from "@/api/types";

// A small banner that appears above the input bar whenever the agent has
// queued one or more proposals for the user's approval. Each row shows
// what the change is + the agent's reason + approve/deny buttons.
//
// Polled every 4s and on tab visibility change. We could subscribe via
// /api/v1/events instead, but the load is trivial and polling avoids one
// more SSE stream from leaking memory if the component unmounts.

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

  async function decide(action: PendingAction, approve: boolean) {
    setBusyIds((p) => new Set(p).add(action.id));
    try {
      if (approve) await api.pending.approve(action.id);
      else await api.pending.deny(action.id);
      await refresh();
      onChange?.();
    } catch (e) {
      console.error(e);
    } finally {
      setBusyIds((p) => { const n = new Set(p); n.delete(action.id); return n; });
    }
  }

  if (pending.length === 0) return null;

  return (
    <div className="mx-4 mb-2 rounded-lg border border-amber-700/60 bg-amber-950/30 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-amber-200 hover:bg-amber-900/20 transition-colors"
      >
        <ShieldAlert size={13} className="text-amber-400 shrink-0" />
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
                  <span className="font-mono uppercase tracking-wide text-[10px] text-amber-400/80">{a.kind}</span>
                  {a.reason && <span className="text-amber-100/90">{a.reason}</span>}
                </div>
                <pre className="text-[11px] text-amber-200/70 font-mono whitespace-pre-wrap break-words bg-amber-950/40 rounded p-2 mb-2">
                  {JSON.stringify(a.payload, null, 2)}
                </pre>
                <div className="flex gap-1.5 justify-end">
                  <button
                    onClick={() => decide(a, false)}
                    disabled={busy}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
                  >
                    <X size={11} /> Deny
                  </button>
                  <button
                    onClick={() => decide(a, true)}
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
  );
}
