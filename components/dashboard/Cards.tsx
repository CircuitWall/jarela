"use client";

export function MetricCard({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-[var(--bg-secondary)]/70 px-3 py-3">
      <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)] inline-flex items-center gap-1.5">
        {icon ? <span className="text-[var(--text-secondary)]">{icon}</span> : null}
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold text-[var(--text-primary)] leading-tight">{value}</p>
    </div>
  );
}

export function InsightChip({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl bg-[var(--bg-secondary)]/55 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)]">{label}</div>
      <div className="mt-1 text-base font-semibold text-[var(--text-primary)]">{value}</div>
      <div className="mt-0.5 text-[11px] text-[var(--text-secondary)]">{hint}</div>
    </div>
  );
}
