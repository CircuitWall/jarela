import { AlertTriangle, Check, LoaderCircle, Minus, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

export type WorkflowChecklistStatus = "pending" | "checking" | "done" | "needs_attention" | "skipped";

export interface WorkflowChecklistItemView {
  id: string;
  label: string;
  status: WorkflowChecklistStatus;
  reason?: string;
  input?: string;
  output?: string;
  validation?: string;
  validation_evidence?: string;
  /** Times this step has been started; shown when greater than one. */
  attempts?: number;
}

interface Props {
  eyebrow: string;
  title: string;
  phaseLabel: string;
  summary: string;
  items: WorkflowChecklistItemView[];
  error?: string | null;
  compact?: boolean;
  /** Retries a single finished or failed step; omitted hides the per-step retry button. */
  onRetryItem?: (item: WorkflowChecklistItemView) => void;
  canRetryItem?: (item: WorkflowChecklistItemView) => boolean;
  retryDisabled?: boolean;
  children?: ReactNode;
}

const RETRYABLE_STATUSES: ReadonlySet<WorkflowChecklistStatus> = new Set(["done", "needs_attention", "skipped"]);

export function isWorkflowItemRetryable(item: WorkflowChecklistItemView): boolean {
  return RETRYABLE_STATUSES.has(item.status);
}

function statusLabel(status: WorkflowChecklistStatus): string {
  if (status === "done") return "verified";
  if (status === "needs_attention") return "needs attention";
  return status;
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

function itemTooltip(item: WorkflowChecklistItemView): string {
  const note = item.status === "done" ? item.validation_evidence : item.reason;
  return note ? `${item.label}\n${statusLabel(item.status)}: ${note}` : item.label;
}

export function WorkflowChecklist({ eyebrow, title, phaseLabel, summary, items, error, compact = false, onRetryItem, canRetryItem, retryDisabled = false, children }: Props) {
  return (
    <div className={compact ? "flex flex-col gap-1.5" : "absolute inset-x-0 top-0 flex flex-col gap-2 transition-opacity duration-300"}>
      {!compact && (
        <p className="text-[10px] text-fg-faint uppercase tracking-wider text-center">
          {eyebrow}
        </p>
      )}
      <div className={compact
        ? "w-full rounded border border-border/40 bg-surface/60 px-2 py-1.5 text-left"
        : "w-full rounded-xl border border-border/60 bg-surface-2/70 px-3 py-2 text-left shadow-lg shadow-black/5"}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-fg truncate">{title}</p>
          <span className="text-[10px] uppercase tracking-wider text-fg-faint">
            {phaseLabel}
          </span>
        </div>
        {!compact && summary && (
          <p className="mt-1 text-[11px] leading-snug text-fg-muted line-clamp-2">
            {summary}
          </p>
        )}
        <ul className={compact
          ? "mt-1.5 flex max-h-48 flex-col gap-0.5 overflow-y-auto pr-1"
          : "mt-2 flex max-h-32 flex-col gap-1 overflow-y-auto pr-1"}>
          {items.map((item) => {
            const retryable = !!onRetryItem && isWorkflowItemRetryable(item) && (canRetryItem ? canRetryItem(item) : true);
            return (
              <li key={item.id} className="group flex items-center gap-1.5 text-[10px] leading-tight text-fg-muted">
                <span
                  role="img"
                  aria-label={statusLabel(item.status)}
                  className={["flex h-4 w-4 shrink-0 items-center justify-center rounded border", statusClass(item.status)].join(" ")}
                >
                  <StatusIcon status={item.status} />
                </span>
                <span className={compact ? "min-w-0 flex-1 truncate" : "min-w-0 flex-1 line-clamp-2"} title={itemTooltip(item)}>
                  {item.label}
                </span>
                {(item.attempts ?? 0) > 1 && (
                  <span className="shrink-0 text-[9px] tabular-nums text-fg-faint" title={`Attempt ${item.attempts}`}>
                    attempt {item.attempts}
                  </span>
                )}
                {retryable && (
                  <button
                    type="button"
                    onClick={() => onRetryItem(item)}
                    disabled={retryDisabled}
                    aria-label={`Retry ${item.label}`}
                    title={`Retry ${item.label}`}
                    className={[
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-surface-3 hover:text-fg disabled:opacity-40",
                      item.status === "needs_attention" ? "" : "opacity-0 focus:opacity-100 group-hover:opacity-100",
                    ].join(" ")}
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {error && (
          <p className="mt-2 text-[10px] leading-tight text-red-400">{error}</p>
        )}
        {children}
      </div>
    </div>
  );
}