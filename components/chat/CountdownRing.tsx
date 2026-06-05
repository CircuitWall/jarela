"use client";

import { useEffect, useState } from "react";
import { runtimeConfig } from "@/api/runtime-config";

// Drains a small SVG ring over the run's wall-clock budget (runMaxMs) so
// the user sees how close the agent is to the run-registry's hard timeout
// instead of a bouncing-dots indicator with no temporal grounding. The
// ring starts full when the streaming bubble first renders and empties
// linearly until either the run finishes (bubble unmounts) or the budget
// elapses. The animation runs on a CSS keyframe so the browser interpolates
// it; React only seeds the animation-duration once on mount.
//
// The visual is intentionally subtle — same color as the surrounding text,
// 0.7rem square — so it reads as a "still working" pulse rather than a
// loud progress bar.
export function CountdownRing() {
  // Re-resolve runMaxMs on mount so the EnvVarsPanel can change the budget
  // and new streams pick it up without a page reload. The runtime-config
  // fetch is non-blocking; until it lands we fall back to its default
  // (20min), which is what runMaxMs defaults to server-side anyway.
  const [deadlineMs, setDeadlineMs] = useState(() => runtimeConfig().runMaxMs);
  useEffect(() => {
    // Pick up the runtime value once on mount; ignore subsequent changes
    // so an in-flight ring doesn't jump if the user edits the env knob
    // mid-stream.
    setDeadlineMs(runtimeConfig().runMaxMs);
  }, []);

  const r = 5.5;
  const c = 2 * Math.PI * r;
  // Spinner arc length: ~25% of the circumference so the gap is large
  // enough to read motion at 14px without the spinner looking like a
  // closed ring.
  const spinnerArc = c * 0.25;
  return (
    <span
      className="jarela-countdown-ring"
      aria-label="agent working"
      role="status"
      style={{ ["--jarela-countdown-ms" as string]: `${deadlineMs}ms` }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle
          cx="7"
          cy="7"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.18"
          strokeWidth="1.4"
        />
        <circle
          className="jarela-countdown-progress"
          cx="7"
          cy="7"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeDasharray={c.toFixed(3)}
          strokeDashoffset="0"
          transform="rotate(-90 7 7)"
          style={{ ["--jarela-countdown-circumference" as string]: c.toFixed(3) }}
        />
        <circle
          className="jarela-countdown-spinner"
          cx="7"
          cy="7"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeDasharray={`${spinnerArc.toFixed(3)} ${(c - spinnerArc).toFixed(3)}`}
        />
      </svg>
    </span>
  );
}
