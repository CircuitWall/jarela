"use client";
import { useEffect } from "react";

/**
 * Mirrors `window.visualViewport` into CSS custom properties so layout can
 * react to the on-screen keyboard on iOS Safari (and any other platform that
 * shrinks the visual viewport without shrinking the layout viewport).
 *
 * Exposed vars on `<html>`:
 *   --visual-vh  → the actual visible height in px (defaults to 100dvh).
 *   --kb-inset   → how many px the keyboard currently occupies at the bottom.
 *
 * No-op on platforms without `visualViewport` (older browsers); CSS fallbacks
 * via `var(--visual-vh, 100dvh)` take over.
 */
export function useVisualViewportInsets() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;

    const root = document.documentElement;

    function apply() {
      const visible = Math.round(vv!.height);
      const inset = Math.max(0, Math.round(window.innerHeight - vv!.height - vv!.offsetTop));
      root.style.setProperty("--visual-vh", `${visible}px`);
      root.style.setProperty("--kb-inset", `${inset}px`);
    }

    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    window.addEventListener("orientationchange", apply);

    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      window.removeEventListener("orientationchange", apply);
      root.style.removeProperty("--visual-vh");
      root.style.removeProperty("--kb-inset");
    };
  }, []);
}
