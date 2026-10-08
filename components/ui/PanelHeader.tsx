import type { ReactNode } from "react";

// Title bar shared by every top-level config panel. Children render as
// right-aligned actions.
export function PanelHeader({ icon, title, children }: { icon: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="border-b border-border px-4 py-3 flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-fg-subtle flex items-center shrink-0" aria-hidden="true">{icon}</span>
      <h2 className="text-sm font-semibold text-fg mr-auto min-w-0 truncate">{title}</h2>
      {children}
    </div>
  );
}

// Standard header action ("New", "Refresh", ...).
export function HeaderAction({
  icon,
  label,
  onClick,
  disabled,
  title,
}: {
  icon?: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="control-tap touch-manipulation flex items-center gap-1 px-1 text-xs text-accent hover:text-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      {icon} {label}
    </button>
  );
}
