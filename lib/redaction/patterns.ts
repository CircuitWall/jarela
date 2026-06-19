// Redaction pattern store. Loads ~/.jarela/redaction-patterns.json, falls
// back to baked-in defaults when the file is missing or invalid, and
// re-reads on file mtime change. See ADR-0064.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getDataDir } from "@/lib/db/data-dir";

export const VALIDATOR_NAMES = ["luhn", "mod97", "personnummer_check"] as const;

const PatternSchema = z.object({
  name: z.string().min(1),
  regex: z.string().min(1),
  type_hint: z.string().min(1),
  validator: z.enum(VALIDATOR_NAMES).optional(),
  enabled: z.boolean().default(true),
});

const EntropyHeuristicSchema = z.object({
  enabled: z.boolean().default(true),
  min_length: z.number().int().positive(),
  min_entropy: z.number().positive(),
  char_class: z.string().min(1),
  exclude_patterns: z.array(z.string()).default([]),
});

const RedactionConfigSchema = z.object({
  patterns: z.array(PatternSchema).default([]),
  heuristics: z
    .object({
      high_entropy: EntropyHeuristicSchema,
    })
    .default({
      high_entropy: {
        enabled: true,
        min_length: 10,
        min_entropy: 4.0,
        char_class: "[A-Za-z0-9_=+/.-]",
        exclude_patterns: [],
      },
    }),
  field_name_allowlist: z.array(z.string()).default([]),
});

export type RedactionConfig = z.infer<typeof RedactionConfigSchema>;

export const DEFAULT_REDACTION_CONFIG: RedactionConfig = {
  patterns: [
    {
      name: "anthropic_api_key",
      regex: "sk-ant-[A-Za-z0-9_-]{20,}",
      type_hint: "anthropic_api_key",
      enabled: true,
    },
    {
      name: "openai_api_key",
      regex: "sk-(?:proj-)?[A-Za-z0-9_-]{20,}",
      type_hint: "openai_api_key",
      enabled: true,
    },
    {
      name: "aws_access_key",
      regex: "AKIA[0-9A-Z]{16}",
      type_hint: "aws_access_key",
      enabled: true,
    },
    {
      name: "github_token",
      regex: "gh[pousr]_[A-Za-z0-9]{36,}",
      type_hint: "github_token",
      enabled: true,
    },
    {
      name: "jwt",
      regex: "eyJ[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+",
      type_hint: "jwt",
      enabled: true,
    },
    {
      name: "pem_block",
      regex: "-----BEGIN [A-Z ]+-----[\\s\\S]+?-----END [A-Z ]+-----",
      type_hint: "pem_block",
      enabled: true,
    },
    {
      name: "bearer_header",
      regex: "Bearer\\s+[A-Za-z0-9._~+/=-]{20,}",
      type_hint: "bearer_token",
      enabled: true,
    },
    {
      name: "us_ssn",
      regex: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
      type_hint: "us_ssn",
      enabled: true,
    },
    {
      name: "swedish_personnummer",
      regex: "\\b(?:\\d{2})?\\d{6}[-+]\\d{4}\\b",
      type_hint: "swedish_personnummer",
      validator: "personnummer_check",
      enabled: true,
    },
    {
      name: "iban",
      regex: "\\b[A-Z]{2}\\d{2}[A-Z0-9]{11,30}\\b",
      type_hint: "iban",
      validator: "mod97",
      enabled: true,
    },
    {
      name: "swedish_bankgiro",
      regex: "\\b\\d{3,4}-\\d{4}\\b",
      type_hint: "swedish_bankgiro",
      validator: "luhn",
      enabled: true,
    },
    {
      name: "swedish_plusgiro",
      regex: "\\b\\d{2,8}-\\d\\b",
      type_hint: "swedish_plusgiro",
      validator: "luhn",
      enabled: true,
    },
  ],
  heuristics: {
    high_entropy: {
      enabled: true,
      // Floor at 10 chars: the entropy filter (4.0 bits/char) effectively
      // gates this at ~16 chars in practice (max entropy of a 10-char
      // string is log2(10) ≈ 3.32), but operators who want to catch
      // shorter secrets can lower min_entropy via redaction-patterns.json
      // without having to bump min_length too.
      min_length: 10,
      min_entropy: 4.0,
      char_class: "[A-Za-z0-9_=+/.-]",
      exclude_patterns: [
        // The entropy char class includes `=`, so `key=<id>` matches as
        // one contiguous run. Anchor each exclude with an optional
        // `<word>=` prefix so identifiers stay excluded whether they
        // appear bare or as the right-hand side of a key=value pair.
        "^(?:\\w+=)?[a-f0-9]{40}$",
        "^(?:\\w+=)?[a-f0-9]{64}$",
        "^(?:\\w+=)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        "^(?:\\w+=)?[0-9A-HJKMNP-TV-Z]{26}$",
        "^[a-z]{2,8}_[A-Za-z0-9]{14,}$",
      ],
    },
  },
  field_name_allowlist: [
    "id", "_id", "uuid", "guid", "node_id",
    "run_id", "job_id", "task_id", "thread_id", "message_id",
    "sha", "commit", "commit_sha", "tree_sha", "parent_sha",
    "url", "uri", "href", "self", "html_url", "api_url",
  ],
};

export const REDACTION_CONFIG_FILENAME = "redaction-patterns.json";

export function getRedactionConfigPath(): string {
  return join(getDataDir(), REDACTION_CONFIG_FILENAME);
}

interface CacheEntry {
  config: RedactionConfig;
  mtimeMs: number;
}

let cache: CacheEntry | null = null;

export function clearRedactionConfigCache(): void {
  cache = null;
}

export function loadRedactionConfig(): RedactionConfig {
  const path = getRedactionConfigPath();

  if (!existsSync(path)) {
    cache = { config: DEFAULT_REDACTION_CONFIG, mtimeMs: 0 };
    return DEFAULT_REDACTION_CONFIG;
  }

  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return cache?.config ?? DEFAULT_REDACTION_CONFIG;
  }

  if (cache && cache.mtimeMs === mtimeMs) return cache.config;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return DEFAULT_REDACTION_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[redaction] failed to parse ${path}; using defaults: ${(err as Error).message}`,
    );
    return DEFAULT_REDACTION_CONFIG;
  }

  const result = RedactionConfigSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(
      `[redaction] invalid config in ${path}; using defaults: ${result.error.message}`,
    );
    return DEFAULT_REDACTION_CONFIG;
  }

  cache = { config: result.data, mtimeMs };
  return result.data;
}

// Write the default config to disk if no file exists yet. Idempotent —
// safe to call on every boot. Intended use: settings UI "open my pattern
// file" action seeds the file before the user edits it.
export function ensureRedactionConfigFile(): string {
  const path = getRedactionConfigPath();
  if (existsSync(path)) return path;
  writeFileSync(path, JSON.stringify(DEFAULT_REDACTION_CONFIG, null, 2), "utf8");
  return path;
}
