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
 * Two distinct iOS behaviours have to be handled:
 *   1. iOS Safari (in-browser): when the on-screen keyboard appears,
 *      `vv.height` shrinks by the keyboard height. `inset` = innerHeight -
 *      vv.height covers this case directly.
 *   2. iOS standalone PWA: `vv.height` typically stays = innerHeight. The
 *      browser instead scrolls the layout viewport up to keep the focused
 *      input visible, surfacing as `window.scrollY > 0` and/or
 *      `vv.offsetTop > 0`. We use that scroll/offset as a keyboard-height
 *      proxy so the input bar can lift above the keyboard.
 *
 * The CSS pinning in `app/globals.css` (`body { position: fixed; inset: 0 }`)
 * prevents iOS from scrolling the document so far that the input bar lands
 * above the visible visual viewport — which was the original PWA bug.
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
      const v = vv!;
      const layoutHidden = Math.max(0, Math.round(window.innerHeight - v.height));
      const scrollProxy = Math.max(0, Math.round((window.scrollY || 0) + v.offsetTop));
      const inset = Math.max(layoutHidden, scrollProxy);
      const visible = Math.max(0, Math.round(window.innerHeight - inset));
      root.style.setProperty("--visual-vh", `${visible}px`);
      root.style.setProperty("--kb-inset", `${inset}px`);
    }

    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    window.addEventListener("orientationchange", apply);
    // iOS PWA: scrolls the layout viewport when an input is focused.
    window.addEventListener("scroll", apply, { passive: true });
    // After the input loses focus, iOS leaves the document scrolled. With
    // body pinned (`position: fixed`) the scroll shouldn't move the view,
    // but we still reset it so the next focus starts from a clean state.
    function onFocusOut() {
      if (window.scrollY !== 0) window.scrollTo(0, 0);
      apply();
    }
    document.addEventListener("focusout", onFocusOut);

    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      window.removeEventListener("orientationchange", apply);
      window.removeEventListener("scroll", apply);
      document.removeEventListener("focusout", onFocusOut);
      root.style.removeProperty("--visual-vh");
      root.style.removeProperty("--kb-inset");
    };
  }, []);
}
