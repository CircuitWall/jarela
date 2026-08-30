import { AlertTriangle, Check, LoaderCircle, Minus } from "lucide-react";
import type { ReactNode } from "react";

export type WorkflowChecklistStatus = "pending" | "checking" | "done" | "needs_attention" | "skipped";

export interface WorkflowChecklistItemView {
  id: string;
  label: string;
  status: WorkflowChecklistStatus;
  reason?: string;
}

interface Props {
  eyebrow: string;
  title: string;
  phaseLabel: string;
  summary: string;
  items: WorkflowChecklistItemView[];
  error?: string | null;
  children?: ReactNode;
}

function StatusIcon({ status }: { status: WorkflowChecklistStatus }) {
  if (status === "done") return <Check className="h-3 w-3" aria-hidden />;
  if (status === "checking") return <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden />;
  if (status === "needs_attention") return <AlertTriangle className="h-3 w-3" aria-hidden />;
  if (status === "skipped") return <Minus className="h-3 w-3" aria-hidden />;
  return <span className="block h-2.5 w-2.5 rounded-[3px] border border-current" aria-hidden />;
}

function statusClass(status: WorkflowChecklistStatus): string {
  if (status === "done") return "border-emerald-400/40 bg-emerald-400/10 text-emerald-300";
  if (status === "checking") return "border-accent/50 bg-accent/15 text-fg";
  if (status === "needs_attention") return "border-amber-400/50 bg-amber-400/10 text-amber-300";
  if (status === "skipped") return "border-border/60 bg-surface text-fg-faint";
  return "border-border/60 bg-surface text-fg-faint";
}

export function WorkflowChecklist({ eyebrow, title, phaseLabel, summary, items, error, children }: Props) {
  return (
    <div className="absolute inset-x-0 top-0 flex flex-col gap-2 transition-opacity duration-300">
      <p className="text-[10px] text-fg-faint uppercase tracking-wider text-center">
        {eyebrow}
      </p>
      <div className="w-full rounded-xl border border-border/60 bg-surface-2/70 px-3 py-2 text-left shadow-lg shadow-black/5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-fg truncate">{title}</p>
          <span className="text-[10px] uppercase tracking-wider text-fg-faint">
            {phaseLabel}
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-fg-muted line-clamp-2">
          {summary}
        </p>
        <div className="mt-2 flex max-h-32 flex-col gap-1 overflow-y-auto pr-1">
          {items.map((item) => (
            <div key={item.id} className="flex items-start gap-1.5 text-[10px] leading-tight text-fg-muted">
              <span className={["mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border", statusClass(item.status)].join(" ")}>
                <StatusIcon status={item.status} />
              </span>
              <span className="line-clamp-2">{item.label}</span>
            </div>
          ))}
        </div>
        {error && (
          <p className="mt-2 text-[10px] leading-tight text-red-400">{error}</p>
        )}
        {children}
      </div>
    </div>
  );
}