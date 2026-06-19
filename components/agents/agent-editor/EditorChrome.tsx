import type React from "react";
import { Dialog } from "@/components/ui/Dialog";

interface ChromeProps {
  title: string;
  variant: "compact" | "full";
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}

export function EditorChrome({ title, variant, onClose, children, footer }: ChromeProps) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size={variant === "full" ? "xl" : "lg"}
      align="top"
      padded={false}
      footer={footer}
    >
      <div className="p-4 space-y-5">{children}</div>
    </Dialog>
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
