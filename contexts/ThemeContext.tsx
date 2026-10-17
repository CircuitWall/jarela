"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type Theme = "light" | "dark" | "system";
export type AccentColor = "default" | "blue" | "teal" | "violet" | "rose";
export type SurfaceStyle = "ambient" | "calm" | "liquid";

const STORAGE_KEY = "jarela-theme";
const ACCENT_STORAGE_KEY = "jarela-accent-color";
const SURFACE_STORAGE_KEY = "jarela-surface-style";

function isTheme(v: unknown): v is Theme {
  return v === "light" || v === "dark" || v === "system";
}

function isAccentColor(v: unknown): v is AccentColor {
  return v === "default" || v === "blue" || v === "teal" || v === "violet" || v === "rose";
}

function isSurfaceStyle(v: unknown): v is SurfaceStyle {
  return v === "ambient" || v === "calm" || v === "liquid";
}

function readStored(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(v) ? v : "system";
  } catch {
    return "system";
  }
}

function readStoredAccent(): AccentColor {
  if (typeof window === "undefined") return "blue";
  try {
    const value = window.localStorage.getItem(ACCENT_STORAGE_KEY);
    return isAccentColor(value) ? value : "default";
  } catch {
    return "default";
  }
}

function readStoredSurface(): SurfaceStyle {
  if (typeof window === "undefined") return "ambient";
  try {
    const value = window.localStorage.getItem(SURFACE_STORAGE_KEY);
    return isSurfaceStyle(value) ? value : "ambient";
  } catch {
    return "ambient";
  }
}

const LIGHT_CHROME = "#ffffff";
const DARK_CHROME = "#09090b";

function resolveChrome(theme: Theme): string {
  if (theme === "light") return LIGHT_CHROME;
  if (theme === "dark") return DARK_CHROME;
  if (typeof window === "undefined") return DARK_CHROME;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? DARK_CHROME : LIGHT_CHROME;
}

// Keep the single <meta name="theme-color"> tag (installed by the pre-paint
// script in app/layout.tsx) aligned with the active surface so the PWA's
// desktop title bar and mobile address bar match the theme.
function syncChrome(theme: Theme) {
  if (typeof document === "undefined") return;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolveChrome(theme));
}

function apply(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  syncChrome(theme);
}

function applyAccentColor(accentColor: AccentColor) {
  if (typeof document === "undefined") return;
  if (accentColor === "default") {
    document.documentElement.removeAttribute("data-accent-color");
    return;
  }
  document.documentElement.setAttribute("data-accent-color", accentColor);
}

function applySurfaceStyle(surfaceStyle: SurfaceStyle) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-surface-style", surfaceStyle);
}

interface Ctx {
  theme: Theme;
  setTheme: (t: Theme) => void;
  accentColor: AccentColor;
  setAccentColor: (color: AccentColor) => void;
  surfaceStyle: SurfaceStyle;
  setSurfaceStyle: (style: SurfaceStyle) => void;
}

const ThemeContext = createContext<Ctx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Initial state stays "system" on the server to match the pre-paint script,
  // which writes data-theme before React hydrates. The effect below syncs the
  // React state to whatever the script (or localStorage) decided.
  const [theme, setThemeState] = useState<Theme>("system");
  const [accentColor, setAccentColorState] = useState<AccentColor>("blue");
  const [surfaceStyle, setSurfaceStyleState] = useState<SurfaceStyle>("ambient");

  useEffect(() => {
    const stored = readStored();
    const storedAccent = readStoredAccent();
    const storedSurface = readStoredSurface();
    setThemeState(stored);
    setAccentColorState(storedAccent);
    setSurfaceStyleState(storedSurface);
    applyAccentColor(storedAccent);
    applySurfaceStyle(storedSurface);
    // When in "system" mode, mirror OS-level changes into the PWA chrome.
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (readStored() === "system") syncChrome("system");
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    apply(t);
    try {
      window.localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore quota / private-mode errors */
    }
  }, []);

  const setAccentColor = useCallback((color: AccentColor) => {
    setAccentColorState(color);
    applyAccentColor(color);
    try {
      if (color === "default") window.localStorage.removeItem(ACCENT_STORAGE_KEY);
      else window.localStorage.setItem(ACCENT_STORAGE_KEY, color);
    } catch {
      /* ignore quota / private-mode errors */
    }
  }, []);

  const setSurfaceStyle = useCallback((style: SurfaceStyle) => {
    setSurfaceStyleState(style);
    applySurfaceStyle(style);
    try {
      window.localStorage.setItem(SURFACE_STORAGE_KEY, style);
    } catch {
      /* ignore quota / private-mode errors */
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, accentColor, setAccentColor, surfaceStyle, setSurfaceStyle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
