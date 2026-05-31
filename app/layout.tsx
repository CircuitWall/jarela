import type { Metadata, Viewport } from "next";
import { AppProvider } from "@/contexts/AppContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { ServiceWorkerRegistration } from "@/components/ui/ServiceWorkerRegistration";
import { getAppName, getAppDescription } from "@/lib/env/app-config";
import "./globals.css";

export const metadata: Metadata = {
  title: getAppName(),
  description: getAppDescription(),
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

// Next 15+ requires themeColor (and color-scheme, viewport, etc.) to live in
// the viewport export, not metadata. The /_not-found warning came from Next
// inheriting this same layout — moving it here fixes both routes at once.
// Match the installed-PWA window chrome (desktop title bar, mobile address
// bar, splash) to the active surface color. Two entries let the OS pick
// based on prefers-color-scheme; the runtime ThemeContext / pre-paint
// script overrides this single <meta name="theme-color"> tag when the
// user picks an explicit light/dark mode.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

// Pre-paint script: reads the persisted theme and sets `data-theme` on
// <html> before the first paint, so light-mode users don't flash dark on
// every page load. Inlined via dangerouslySetInnerHTML — the canonical
// App Router pattern. (Earlier attempt routed this through next/script,
// but under Next 16 + React 19.2 that import resolves to a Promise in
// some module-resolution paths, tripping "Element type is invalid".)
// Falls back to "system", which then defers to prefers-color-scheme.
const themeBootstrap = `(() => {
  var LIGHT = "#ffffff", DARK = "#09090b";
  function resolve(t) {
    if (t === "light") return LIGHT;
    if (t === "dark") return DARK;
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? DARK : LIGHT;
    } catch (e) { return DARK; }
  }
  try {
    var t = localStorage.getItem("jarela-theme");
    if (t !== "light" && t !== "dark" && t !== "system") t = "system";
    document.documentElement.setAttribute("data-theme", t);
    // Collapse any media-scoped theme-color metas Next emits to a single tag
    // so the PWA window chrome matches the user's explicit choice (not just
    // prefers-color-scheme). ThemeContext keeps this in sync on change.
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 1; i < metas.length; i++) metas[i].parentNode.removeChild(metas[i]);
    var meta = metas[0];
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    meta.removeAttribute("media");
    meta.setAttribute("content", resolve(t));
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "system");
  }
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="system" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        <ThemeProvider>
          <AppProvider>{children}</AppProvider>
        </ThemeProvider>
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
