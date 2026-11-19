import { z } from "zod";

export const REMOTE_DOCUMENT_SOURCE_KINDS = [
  "confluence_space",
  "confluence_cql",
  "jira_project",
  "jira_jql",
  "github_pulls",
  "github_repo",
  "gmail_mail",
  "outlook_mail",
  "icloud_mail",
] as const;

export const localDocumentSourceSchema = z.object({
  path: z.string().min(1),
  label: z.string().nullable().optional(),
  kind: z.literal("local_folder").optional(),
});

export const remoteDocumentSourceSchema = z.object({
  kind: z.enum(REMOTE_DOCUMENT_SOURCE_KINDS),
  label: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
});

export const documentSourcePatchSchema = z.object({
  label: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

// Per-source counters are intentionally limited to what costs nothing to
// compute: a document count is index-only (~ms for every source). Counting
// chunks or embeddings reads the whole 2.8 GB chunk table (3–17 s measured),
// so those numbers are gone rather than kept on a slow path.
export const documentSourceStatsSchema = z.object({
  source_id: z.string(),
  document_count: z.number().int().nonnegative(),
});

export type DocumentSourceKind = "local_folder" | typeof REMOTE_DOCUMENT_SOURCE_KINDS[number];
export type DocumentSourceIn = z.infer<typeof localDocumentSourceSchema> | z.infer<typeof remoteDocumentSourceSchema>;
export type DocumentSourcePatch = z.infer<typeof documentSourcePatchSchema>;
export type DocumentSourceStats = z.infer<typeof documentSourceStatsSchema>;
