"use client";

interface ToolSettingsActionRowProps {
  onSave: () => void;
  saving: boolean;
  saveLabel?: string;
  savingLabel?: string;
  hint?: string;
  onReset?: () => void;
  resetLabel?: string;
  resetDisabled?: boolean;
}

export function ToolSettingsActionRow({
  onSave,
  saving,
  saveLabel = "Save",
  savingLabel = "Saving...",
  hint,
  onReset,
  resetLabel = "Reset",
  resetDisabled,
}: ToolSettingsActionRowProps) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <button
        onClick={onSave}
        disabled={saving}
        className="text-xs px-2 py-1 rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
      >
        {saving ? savingLabel : saveLabel}
      </button>
      {onReset && (
        <button
          onClick={onReset}
          disabled={saving || !!resetDisabled}
          className="text-xs px-2 py-1 rounded border border-border text-fg-muted hover:bg-surface-3 disabled:opacity-40"
        >
          {resetLabel}
        </button>
      )}
      {hint && <span className="text-[11px] text-fg-faint">{hint}</span>}
    </div>
  );
}
