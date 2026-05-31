"use client";
import { useActivityLabel } from "@/lib/ui/loading";

// Inline "what is happening right now" text rendered next to the agent
// dropdown. Replaces the old TopProgressBar: a single short label that
// updates live as the run progresses (Sending… / Thinking… / Using <tool>…).
// Returns null when nothing is in flight so the header stays calm.
export function HeaderActivity() {
  const label = useActivityLabel();
  if (!label) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      className="ml-1 inline-flex items-center gap-1.5 text-xs text-fg-faint truncate max-w-[14rem]"
    >
      <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
        <span className="absolute inset-0 rounded-full bg-accent/70 animate-ping" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
      </span>
      <span className="truncate">{label}</span>
    </span>
  );
}
