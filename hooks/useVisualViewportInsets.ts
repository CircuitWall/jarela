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
 * Platform strategy (cheapest signal that fires wins):
 *   - Chromium ≥ 108: the `interactive-widget=resizes-content` viewport meta
 *     in `app/layout.tsx` shrinks the layout viewport when the keyboard
 *     appears, so `100dvh` and `env(safe-area-inset-bottom)` already do
 *     the right thing without any JS.
 *   - Chromium (where supported): we opt into the VirtualKeyboard API so
 *     `env(keyboard-inset-*)` becomes available to CSS. `InputBar` reads
 *     it via `max(--kb-inset, env(keyboard-inset-height))`.
 *   - iOS Safari (in-browser): `vv.height` shrinks when the keyboard
 *     appears. `inset = innerHeight - vv.height` covers this directly.
 *   - iOS standalone PWA: `vv.height` stays = innerHeight; the browser
 *     scrolls the layout viewport up to keep the focused input visible.
 *     We use `window.scrollY + vv.offsetTop` as the keyboard-height proxy.
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
    };
  }, []);
}
