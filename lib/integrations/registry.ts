// Static registry of all integration manifests. New integrations must be
// added here AND ship a manifest.ts; the lint check
// (scripts/check-integration-manifests.mjs) verifies the two stay in sync.
//
// We use static imports rather than a dynamic `import.meta.glob`-style
// loader because the Next.js bundler needs the imports visible at build
// time (the agent tools that read manifests run server-side in the same
// runtime as the Next API routes).

import { atlassianManifest } from "@/lib/integrations/atlassian/manifest";
import { githubManifest } from "@/lib/integrations/github/manifest";
import { gmailManifest } from "@/lib/integrations/gmail/manifest";
import { googleManifest } from "@/lib/integrations/google/manifest";
import { jiraAlignManifest } from "@/lib/integrations/jira_align/manifest";
import { outlookManifest } from "@/lib/integrations/outlook/manifest";
import type { IntegrationManifest } from "@/lib/integrations/manifest";
import { validateManifest } from "@/lib/integrations/manifest";

const RAW: IntegrationManifest[] = [
  atlassianManifest,
  githubManifest,
  gmailManifest,
  googleManifest,
  jiraAlignManifest,
  outlookManifest,
];

// Validate at module load. A bad manifest is a build-time bug we want to
// surface immediately, not a runtime surprise the agent papers over.
const MANIFESTS: IntegrationManifest[] = RAW.map((m) => validateManifest(m));

export function listManifests(): IntegrationManifest[] {
  return MANIFESTS.slice();
}

export function getManifest(id: string): IntegrationManifest | null {
  return MANIFESTS.find((m) => m.id === id) ?? null;
}

export function manifestIds(): string[] {
  return MANIFESTS.map((m) => m.id).sort();
}
