"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "jarela-theme";

function isTheme(v: unknown): v is Theme {
  return v === "light" || v === "dark" || v === "system";
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

interface Ctx {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<Ctx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Initial state stays "system" on the server to match the pre-paint script,
  // which writes data-theme before React hydrates. The effect below syncs the
  // React state to whatever the script (or localStorage) decided.
  const [theme, setThemeState] = useState<Theme>("system");

  useEffect(() => {
    const stored = readStored();
    setThemeState(stored);
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

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
