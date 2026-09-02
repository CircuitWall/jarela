import { buildManifest } from "@/lib/env/app-manifest";

// Next serves this at /manifest.webmanifest; app/layout.tsx points
// metadata.manifest there. Content is brand-config driven — see
// lib/env/app-manifest.ts.
export default buildManifest;
