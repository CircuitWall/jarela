import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon-192.png", "icon-512.png"],
      manifest: {
        name: "LangGUI",
        short_name: "LangGUI",
        description: "Local chat interface for LangGraph agents",
        start_url: "/",
        display: "standalone",
        background_color: "#09090b",
        theme_color: "#2563eb",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        runtimeCaching: [
          {
            urlPattern: /^\/api\/v1\/threads/,
            handler: "NetworkFirst",
            options: {
              cacheName: "threads-cache",
              expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 3600 },
              networkTimeoutSeconds: 5,
            },
          },
          {
            urlPattern: /^\/api\/v1\/memory/,
            handler: "NetworkFirst",
            options: {
              cacheName: "memory-cache",
              expiration: { maxEntries: 500, maxAgeSeconds: 7 * 24 * 3600 },
              networkTimeoutSeconds: 5,
            },
          },
          {
            urlPattern: /^\/api\/v1\/agents/,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "agents-cache",
              expiration: { maxEntries: 20, maxAgeSeconds: 24 * 3600 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
