import type React from "react";
import { useState } from "react";
import { ChevronDown } from "lucide-react";

interface Props {
  step?: number;
  title: string;
  children: React.ReactNode;
  defaultCollapsed?: boolean;
}

export function Section({ step, title, children, defaultCollapsed }: Props) {
  const collapsible = defaultCollapsed !== undefined;
  const [open, setOpen] = useState(!defaultCollapsed);
  return (
    <div className="rounded-xl border border-border bg-surface-1/30 p-3">
      <div
        className={`flex items-center gap-2 ${collapsible ? "cursor-pointer select-none" : ""}`}
        onClick={collapsible ? () => setOpen((v) => !v) : undefined}
        role={collapsible ? "button" : undefined}
        aria-expanded={collapsible ? open : undefined}
      >
        {step !== undefined && (
          <span className="w-5 h-5 rounded-full bg-accent text-white text-[10px] font-bold flex items-center justify-center shrink-0">
            {step}
          </span>
        )}
        <span className="text-xs font-semibold text-fg-muted uppercase tracking-wide">{title}</span>
        {collapsible && (
          <ChevronDown
            size={13}
            className={`ml-auto text-fg-faint transition-transform ${open ? "rotate-180" : ""}`}
          />
        )}
      </div>
      {(!collapsible || open) && (
        <div className={`${step !== undefined ? "ml-7" : ""} mt-2.5 space-y-2`}>{children}</div>
      )}
    </div>
  );
}
