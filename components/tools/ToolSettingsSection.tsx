"use client";

import type { ReactNode } from "react";

export function ToolSettingsSection({
  title,
  description,
  icon,
  actions,
  children,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface-2/70 p-4 space-y-3">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {actions ? <div className="ml-auto">{actions}</div> : null}
      </div>
      {description ? (
        <p className="text-xs text-fg-muted">{description}</p>
      ) : null}
      {children}
    </section>
  );
}
