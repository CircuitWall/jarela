import type { Metadata, Viewport } from "next";
import { AppProvider } from "@/contexts/AppContext";
import { ServiceWorkerRegistration } from "@/components/ui/ServiceWorkerRegistration";
import "./globals.css";

export const metadata: Metadata = {
  title: "LangGUI",
  description: "Local chat interface for LangGraph agents",
  manifest: "/manifest.json",
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppProvider>{children}</AppProvider>
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
