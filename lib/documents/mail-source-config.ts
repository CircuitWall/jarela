import { z } from "zod";

export const mailSourceConfigSchema = z.object({
  scope: z.enum(["inbox", "folder", "all"]).optional(),
  folder: z.string().trim().min(1).optional(),
  query: z.string().trim().optional(),
  max_results: z.number().int().positive().optional(),
  page_size: z.number().int().min(1).max(100).optional(),
  retention: z.enum(["archive", "mirror"]).optional(),
}).superRefine((config, ctx) => {
  if (!config.scope && !config.query) {
    ctx.addIssue({ code: "custom", message: "Choose a mailbox scope or provide a search query." });
  }
  if (config.scope === "folder" && !config.folder) {
    ctx.addIssue({ code: "custom", message: "A folder or label is required for folder scope." });
  }
});

export function parseMailSourceConfig(value: unknown) {
  const config = mailSourceConfigSchema.parse(value);
  const legacy = !config.scope;
  return {
    ...config,
    query: config.query ?? "",
    max_results: legacy
      ? Math.min(config.max_results ?? 250, 5_000)
      : config.max_results ?? Infinity,
    page_size: config.page_size ?? 100,
    retention: config.retention ?? (legacy ? "mirror" : "archive"),
  };
}
