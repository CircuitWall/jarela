import type React from "react";

interface Props {
  step: number;
  title: string;
  children: React.ReactNode;
}

export function Section({ step, title, children }: Props) {
  return (
    <div className="space-y-2.5 rounded-xl border border-border bg-surface-1/30 p-3">
      <div className="flex items-center gap-2">
        <span className="w-5 h-5 rounded-full bg-accent text-white text-[10px] font-bold flex items-center justify-center shrink-0">
          {step}
        </span>
        <span className="text-xs font-semibold text-fg-muted uppercase tracking-wide">{title}</span>
      </div>
      <div className="ml-7 space-y-2">{children}</div>
    </div>
  );
}
