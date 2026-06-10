import { X } from "lucide-react";
import type React from "react";

interface ChromeProps {
  title: string;
  variant: "compact" | "full";
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}

export function EditorChrome({ title, variant, onClose, children, footer }: ChromeProps) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 p-2 sm:p-4 overflow-y-auto">
      <div className={`bg-surface-2 border border-border rounded-2xl w-full shadow-xl my-2 sm:my-4 ${variant === "full" ? "max-w-2xl" : "max-w-xl"}`}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          <button onClick={onClose} className="text-fg-subtle hover:text-fg transition-colors">
            <X size={16} />
          </button>
        </div>
        <div className="p-4 space-y-5">{children}</div>
        {footer}
      </div>
    </div>
  );
}

interface FooterProps {
  isDefault: boolean;
  onIsDefaultChange: (v: boolean) => void;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}

export function EditorFooter({ isDefault, onIsDefaultChange, saving, onSave, onClose }: FooterProps) {
  return (
    <div className="flex items-center justify-between px-4 pb-4">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          className="rounded border-border"
          checked={isDefault}
          onChange={(e) => onIsDefaultChange(e.target.checked)}
        />
        <span className="text-xs text-fg-subtle">Set as default agent</span>
      </label>
      <div className="flex gap-2">
        <button onClick={onClose} className="px-3 py-1.5 text-sm text-fg-subtle hover:text-fg transition-colors">
          Cancel
        </button>
        <button
          onClick={onSave}
          disabled={saving}
          className="px-4 py-1.5 text-sm bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
