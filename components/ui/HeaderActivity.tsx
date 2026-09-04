"use client";
import { useActivity } from "@/lib/ui/loading";
import { CountdownRing } from "./CountdownRing";

// The single live-status surface: "is the agent alive, and what step is it
// on". Sticky next to the agent dropdown, so it stays readable at any scroll
// position — the message list carries the detail (tool arguments, results),
// this carries the summary. Returns null when nothing is in flight.
export function HeaderActivity() {
  const { label, inflightTools } = useActivity();
  if (!label) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      className="ml-1 inline-flex items-center gap-1.5 text-xs text-fg-faint truncate max-w-[14rem]"
    >
      <CountdownRing inflightToolCount={inflightTools} />
      <span className="truncate">{label}</span>
    </span>
  );
}
