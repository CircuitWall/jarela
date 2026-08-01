"use client";
import Link from "next/link";
import { X } from "lucide-react";

interface Props {
  authError: { message: string; credential_id?: string; provider?: string } | null;
  onDismiss: () => void;
}

// Rendered above the InputBar when the last chat turn failed because the
// model's credential was rejected. Deep-links to /settings/credentials so
// the user can fix the underlying key in one click. See ADR-0068.
export function AuthErrorBanner({ authError, onDismiss }: Props) {
  if (!authError) return null;
  const href = authError.credential_id
    ? `/settings/credentials?edit=${encodeURIComponent(authError.credential_id)}`
    : "/settings/credentials";
  const label = authError.provider
    ? `Fix ${authError.provider} credential`
    : "Fix credential";
  return (
    <div
      role="alert"
      className="mx-3 mb-2 flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-800 dark:text-rose-200"
    >
      <div className="flex-1">
        <div className="font-medium">Credential rejected</div>
        <div className="mt-0.5 text-xs opacity-90 break-words">{authError.message}</div>
      </div>
      <Link
        href={href}
        className="shrink-0 rounded border border-rose-500/50 bg-rose-500/20 px-2 py-1 text-xs font-medium hover:bg-rose-500/30"
      >
        {label}
      </Link>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="shrink-0 rounded p-1 text-rose-600/80 hover:bg-rose-500/10 dark:text-rose-300/80"
      >
        <X size={14} />
      </button>
    </div>
  );
}
