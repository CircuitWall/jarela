"use client";

import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "@/hooks/useEscapeKey";

// Shared modal shell. Centralises Esc-to-close, body scroll lock, the
// backdrop opacity (was 60/70 across sites), and the z-index ladder
// (was 50/60/70). Hand-rolled overlays kept getting at least one of
// these wrong; the bug fix lives here once.
//
// Layout contract:
//   align="top"    — overlay scrolls; card grows with content. Use for
//                    forms that may exceed viewport.
//   align="center" — card capped at max-h-[90vh]; the body region
//                    scrolls. Use for compact confirms / small forms.

const SIZE = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-xl",
  xl: "max-w-2xl",
  full: "max-w-[min(96vw,1400px)]",
} as const;

const LEVEL = {
  default: "z-50",
  elevated: "z-[60]",
  topmost: "z-[70]",
} as const;

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Content rendered before the title in the header (e.g. back button). */
  titlePrefix?: ReactNode;
  children: ReactNode;
  /** Rendered outside the scrollable body so it stays fixed above the fold. */
  footer?: ReactNode;
  size?: keyof typeof SIZE;
  align?: "top" | "center";
  /** Stack the dialog above existing dialogs (e.g. confirm-on-top-of-edit). */
  level?: keyof typeof LEVEL;
  /** Close when the backdrop is clicked. Default true. */
  dismissOnBackdrop?: boolean;
  /** Close when Escape is pressed. Default true. */
  dismissOnEscape?: boolean;
  /** Show the X button in the header. Default true when a title is given. */
  showClose?: boolean;
  /** Apply default body padding/spacing wrapper. Default true. */
  padded?: boolean;
  /** Render edge-to-edge at viewport size (used for immersive previews). */
  fitViewport?: boolean;
}

export function Dialog({
  open,
  onClose,
  title,
  titlePrefix,
  children,
  footer,
  size = "md",
  align = "top",
  level = "default",
  dismissOnBackdrop = true,
  dismissOnEscape = true,
  showClose,
  padded = true,
  fitViewport = false,
}: DialogProps) {
  useEscapeKey(onClose, open && dismissOnEscape);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  const showHeader = title !== undefined || titlePrefix !== undefined;
  const renderClose = showClose ?? showHeader;

  const overlayCls =
    "fixed inset-0 box-border bg-black/60 flex justify-center " +
    (fitViewport ? "p-0 " : "p-2 sm:p-4 ") +
    LEVEL[level] +
    " " +
    (fitViewport ? "items-stretch" : (align === "top" ? "items-start overflow-y-auto" : "items-center"));

  const cardCls =
    (fitViewport
      ? "bg-surface-2 w-full h-full max-w-full max-h-full shadow-xl flex flex-col rounded-none border-0"
      : "bg-surface-2 border border-border rounded-2xl w-full shadow-xl flex flex-col " +
        SIZE[size] +
        " " +
        (align === "top" ? "my-2 sm:my-4" : "max-h-full"));

  return createPortal(
    <div
      className={overlayCls}
      style={{
        paddingTop: fitViewport ? "env(safe-area-inset-top)" : "max(0.5rem, env(safe-area-inset-top))",
        paddingRight: fitViewport ? "env(safe-area-inset-right)" : "max(0.5rem, env(safe-area-inset-right))",
        paddingBottom: fitViewport ? "env(safe-area-inset-bottom)" : "max(0.5rem, env(safe-area-inset-bottom))",
        paddingLeft: fitViewport ? "env(safe-area-inset-left)" : "max(0.5rem, env(safe-area-inset-left))",
      }}
      role="presentation"
      onMouseDown={dismissOnBackdrop ? onClose : undefined}
    >
      <div
        className={cardCls}
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {(showHeader || renderClose) && (
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
            {titlePrefix}
            {title !== undefined && (
              <h3 className="text-sm font-semibold text-fg flex-1 truncate">{title}</h3>
            )}
            {renderClose && (
              <button
                type="button"
                onClick={onClose}
                className={
                  "shrink-0 min-h-9 min-w-9 inline-flex items-center justify-center text-fg-subtle hover:text-fg transition-colors" +
                  (title === undefined && titlePrefix === undefined ? " ml-auto" : "")
                }
                aria-label="Close"
              >
                <X size={16} />
              </button>
            )}
          </div>
        )}
        <div className={`flex-1 min-h-0 overflow-y-auto ${padded ? "p-4 space-y-3" : ""}`}>
          {children}
        </div>
        {footer}
      </div>
    </div>,
    document.body,
  );
}
