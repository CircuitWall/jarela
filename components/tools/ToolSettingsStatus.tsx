"use client";

import { AlertCircle, CheckCircle2 } from "lucide-react";

export function ToolSettingsStatus({
  status,
  error,
}: {
  status?: string | null;
  error?: string | null;
}) {
  if (error) {
    return (
      <p className="text-xs text-rose-700 dark:text-rose-400 flex items-center gap-1">
        <AlertCircle size={12} /> {error}
      </p>
    );
  }
  if (status) {
    return (
      <p className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
        <CheckCircle2 size={12} /> {status}
      </p>
    );
  }
  return null;
}
