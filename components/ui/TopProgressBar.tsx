"use client";
import { useEffect, useState } from "react";
import { useLoadingCount } from "@/lib/ui/loading";

// Thin indeterminate progress bar pinned to the top of the viewport.
// Visible whenever any tracked async work is in flight. Fades in fast and
// fades out after a short delay so quick operations don't strobe.
export function TopProgressBar() {
  const count = useLoadingCount();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (count > 0) {
      setVisible(true);
      return;
    }
    // Linger briefly after work completes for a smoother fade-out.
    const t = setTimeout(() => setVisible(false), 200);
    return () => clearTimeout(t);
  }, [count]);

  return (
    <div
      className={`pointer-events-none fixed top-0 left-0 right-0 h-[2px] z-50 transition-opacity duration-150 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      aria-hidden={!visible}
    >
      <div className="langgui-progress h-full w-full" />
    </div>
  );
}
