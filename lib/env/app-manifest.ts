import type { MetadataRoute } from "next";
import {
  getAppDescription,
  getAppIcons,
  getAppName,
  getAppShortName,
} from "./app-config";

// PWA manifest content, derived from the brand config rather than a static
// public/manifest.json, so a rebranded overlay gets its own name /
// short_name / description / icons from the NEXT_PUBLIC_APP_* knobs without
// editing JSON inside the package.
//
// Lives in lib/ (not app/) so it's unit-testable — app/manifest.ts is a thin
// route wrapper that Next serves at /manifest.webmanifest.
export function buildManifest(): MetadataRoute.Manifest {
  const icons = getAppIcons();
  return {
    name: getAppName(),
    short_name: getAppShortName(),
    description: getAppDescription(),
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["minimal-ui", "standalone"],
    background_color: "#09090b",
    theme_color: "#09090b",
    // Not in Next's Manifest type, but valid per the Edge side-panel spec —
    // carried over from the static manifest this replaced.
    ...({ edge_side_panel: { preferred_width: 480 } } as Record<string, unknown>),
    icons: [
      { src: icons.icon192, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: icons.icon192Maskable, sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: icons.icon512, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: icons.icon512Maskable, sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: icons.icon192Light, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: icons.icon192MaskableLight, sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: icons.icon512Light, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: icons.icon512MaskableLight, sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: icons.appleTouchIcon, sizes: "180x180", type: "image/png", purpose: "any" },
    ],
  };
}
