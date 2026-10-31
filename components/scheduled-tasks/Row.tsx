import type { ReactNode } from "react";

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-20 shrink-0 text-fg-faint">{label}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
