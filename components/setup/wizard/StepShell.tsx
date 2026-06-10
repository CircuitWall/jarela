"use client";
import type { ReactNode } from "react";

interface StepShellProps {
  icon: ReactNode;
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}

export function StepShell({ icon, eyebrow, title, description, children }: StepShellProps) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <header className="space-y-2">
        <div className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-faint">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent/15 text-accent">{icon}</span>
          {eyebrow}
        </div>
        <h2 className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">{title}</h2>
        <p className="text-sm leading-relaxed text-fg-subtle">{description}</p>
      </header>
      <div className="space-y-4">{children}</div>
    </div>
  );
}
