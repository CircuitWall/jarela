import { X } from "lucide-react";
import type React from "react";

interface Props {
  title: string;
  wide: boolean;
  onClose: () => void;
  expertToggle: React.ReactNode | null;
  children: React.ReactNode;
  footer: React.ReactNode;
  overlays?: React.ReactNode;
}

export function EditorChrome({ title, wide, onClose, expertToggle, children, footer, overlays }: Props) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 p-2 sm:p-4 overflow-y-auto">
      <div className={`bg-surface-2 border border-border rounded-2xl w-full shadow-xl my-2 sm:my-4 ${wide ? "max-w-2xl" : "max-w-xl"}`}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          <button onClick={onClose} className="text-fg-subtle hover:text-fg transition-colors"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-3.5">
          {expertToggle}
          {children}
        </div>
        {footer}
      </div>
      {overlays}
    </div>
  );
}

interface ExpertToggleProps {
  showExpert: boolean;
  onToggle: () => void;
}

export function ExpertToggle({ showExpert, onToggle }: ExpertToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={showExpert}
      className="text-[11px] text-fg-faint hover:text-fg-muted transition-colors inline-flex items-center gap-1"
    >
      {showExpert ? "Hide advanced fields" : "Show advanced fields (context tuning, base URL, headers)"}
    </button>
  );
}
