import type { ReactNode } from "react";

// Centered loading / empty-list line used inside panel bodies.
export function PanelMessage({ children }: { children: ReactNode }) {
  return <p role="status" className="text-fg-faint text-sm py-6 text-center">{children}</p>;
}
