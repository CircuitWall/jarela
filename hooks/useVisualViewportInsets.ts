"use client";
import { useEffect } from "react";

/**
 * Mirrors `window.visualViewport` into CSS custom properties so layout can
 * react to the on-screen keyboard on iOS Safari (and any other platform that
 * shrinks the visual viewport without shrinking the layout viewport).
 *
 * Exposed vars on `<html>`:
 *   --visual-vh        → the actual visible height in px (defaults to 100dvh).
 *   --kb-inset         → how many px the keyboard currently occupies at
 *                        the bottom.
 *   --kb-scroll-offset → how many px iOS shifted the layout viewport up to
 *                        expose the focused input (PWA-specific). AppShell
 *                        applies this as `margin-top` so it stays aligned
 *                        with the visual viewport instead of riding up with
 *                        the layout scroll.
 *
 * Consumers:
 *   - AppShell uses `--visual-vh` as its container height AND
 *     `--kb-scroll-offset` as `margin-top` so the shell fills the visible
 *     viewport exactly even when iOS auto-scrolls the layout in standalone
 *     PWA. InputBar does NOT add `--kb-inset` as padding — the shell
 *     already shrinks to fit.
 *
 * The CSS pinning in `app/globals.css` (`body { position: fixed; inset: 0 }`)
 * prevents iOS from scrolling the document so far that the input bar lands
 * above the visible visual viewport — which was the original PWA bug.
 *
 * No-op on platforms without `visualViewport` (older browsers); CSS fallbacks
 * via `var(--visual-vh, 100dvh)` take over.
 */
type VirtualKeyboardLike = {
  overlaysContent: boolean;
  boundingRect: { height: number };
  addEventListener: (type: "geometrychange", listener: () => void) => void;
  removeEventListener: (type: "geometrychange", listener: () => void) => void;
};

export function useVisualViewportInsets() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;

    const root = document.documentElement;

    // Opt into the Chromium VirtualKeyboard API so `env(keyboard-inset-*)`
    // becomes populated. With `overlaysContent=true` the browser stops
    // resizing the layout viewport (overriding `interactive-widget`) and
    // instead exposes the keyboard rectangle via the env() vars — that's
    // what InputBar reads. We still need the visualViewport path as a
    // fallback for browsers without this API (Safari).
    const vk = (navigator as unknown as { virtualKeyboard?: VirtualKeyboardLike })
      .virtualKeyboard;
    if (vk) {
      try { vk.overlaysContent = true; } catch { /* feature-flagged off */ }
    }

    function apply() {
      const v = vv!;
      const layoutHidden = Math.max(0, Math.round(window.innerHeight - v.height));
      const scrollProxy = Math.max(0, Math.round((window.scrollY || 0) + v.offsetTop));
      const vkHeight = vk ? Math.max(0, Math.round(vk.boundingRect.height)) : 0;
      const inset = Math.max(layoutHidden, scrollProxy, vkHeight);
      const visible = Math.max(0, Math.round(window.innerHeight - inset));
      root.style.setProperty("--visual-vh", `${visible}px`);
      root.style.setProperty("--kb-inset", `${inset}px`);
      // Counter-offset for iOS PWA: the OS scrolls the layout viewport up
      // to expose the focused input, which would drag the (position:fixed)
      // body and its children with it. AppShell adds this as `margin-top`
      // so it re-aligns with the visible visual viewport.
      root.style.setProperty("--kb-scroll-offset", `${scrollProxy}px`);
    }

    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    window.addEventListener("orientationchange", apply);
    // iOS PWA: scrolls the layout viewport when an input is focused.
    window.addEventListener("scroll", apply, { passive: true });
    if (vk) vk.addEventListener("geometrychange", apply);
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
      if (vk) vk.removeEventListener("geometrychange", apply);
      document.removeEventListener("focusout", onFocusOut);
      root.style.removeProperty("--visual-vh");
      root.style.removeProperty("--kb-inset");
      root.style.removeProperty("--kb-scroll-offset");
    };
  }, []);
}
