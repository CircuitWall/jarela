import type { Metadata, Viewport } from "next";
import { AppProvider } from "@/contexts/AppContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { ServiceWorkerRegistration } from "@/components/ui/ServiceWorkerRegistration";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jarela",
  description: "Jarela — local chat interface for LangGraph agents",
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
export const viewport: Viewport = {
  themeColor: "#2563eb",
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
  try {
    var t = localStorage.getItem("jarela-theme");
    if (t !== "light" && t !== "dark" && t !== "system") t = "system";
    document.documentElement.setAttribute("data-theme", t);
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
