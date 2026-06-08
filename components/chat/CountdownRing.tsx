"use client";

import { useEffect, useRef, useState } from "react";
import { runtimeConfig } from "@/api/runtime-config";

// Drains a small SVG ring over the run's *effective* wall-clock budget
// (`runMaxMs`), mirroring the adaptive logic in lib/agents/run-registry.ts:
// the wall-clock bounds agent + provider time only, so time spent inside
// tool calls does not advance the ring. While `inflightToolCount > 0` the
// drain pauses; when all tools resolve it resumes from where it left off.
//
// Progress is driven in JS via rAF (not a CSS keyframe) so the pause can
// happen mid-stream without a janky restart. A separate spinner arc keeps
// rotating regardless — that's the "still alive" cue.
export function CountdownRing({ inflightToolCount = 0 }: { inflightToolCount?: number }) {
  // Re-resolve runMaxMs on mount so the EnvVarsPanel can change the budget
  // and new streams pick it up without a page reload.
  const [deadlineMs, setDeadlineMs] = useState(() => runtimeConfig().runMaxMs);
  useEffect(() => {
    setDeadlineMs(runtimeConfig().runMaxMs);
  }, []);

  const r = 5.5;
  const c = 2 * Math.PI * r;
  const spinnerArc = c * 0.25;

  const progressRef = useRef<SVGCircleElement | null>(null);
  // Cumulative ms the ring has drained — only advances while no tools
  // are inflight. Kept in a ref so the rAF loop never triggers re-renders.
  const activeMsRef = useRef(0);
  // performance.now() of the previous tick. Reset to null on pause/resume
  // so the paused interval doesn't get retroactively counted.
  const lastTickRef = useRef<number | null>(null);
  const inflightRef = useRef(inflightToolCount);

  useEffect(() => {
    inflightRef.current = inflightToolCount;
    lastTickRef.current = null;
  }, [inflightToolCount]);

  useEffect(() => {
    if (typeof requestAnimationFrame === "undefined") return;
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      if (inflightRef.current === 0) {
        if (lastTickRef.current !== null) {
          activeMsRef.current += now - lastTickRef.current;
        }
        lastTickRef.current = now;
      } else {
        lastTickRef.current = null;
      }
      const node = progressRef.current;
      if (node) {
        const progress = Math.min(1, activeMsRef.current / Math.max(1, deadlineMs));
        node.style.strokeDashoffset = (c * progress).toFixed(3);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [c, deadlineMs]);

  return (
    <span
      className="jarela-countdown-ring"
      aria-label="agent working"
      role="status"
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
          ref={progressRef}
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
