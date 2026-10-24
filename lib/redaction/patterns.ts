// Redaction pattern store. Loads ~/.jarela/redaction-patterns.json, falls
// back to baked-in defaults when the file is missing or invalid, and
// re-reads on file mtime change. See ADR-0064.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getDataDir } from "@/lib/db/data-dir";

export const VALIDATOR_NAMES = ["luhn", "mod97", "personnummer_check", "credential_shape"] as const;

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

// Pure-digit runs (credit cards, phone numbers, account numbers, generic
// numeric IDs) have low Shannon entropy and slip past the high-entropy
// heuristic. This catches consecutive digits optionally joined by
// `separators` (e.g. "4111 1111 1111 1111", "+46-70-123-4567"), counting
// digits only against `min_digits`.
const DigitRunHeuristicSchema = z.object({
  enabled: z.boolean().default(true),
  min_digits: z.number().int().positive(),
  separators: z.string().min(1),
  exclude_patterns: z.array(z.string()).default([]),
});

const DEFAULT_DIGIT_RUN = {
  enabled: true,
  // 8 digits catches phone numbers (and longer: credit cards, IBAN
  // tails, account numbers) while leaving 6-digit OTPs, 5-digit ZIPs,
  // and 4-digit PINs / years alone.
  min_digits: 8,
  // Spaces, hyphens, and dots are the common human-readable
  // separators for numeric secrets. `/` is intentionally excluded so
  // dates like `2026/06/19` stay unmatched.
  separators: " -.",
  // Everyday numbers that are 8+ digits once separators are ignored:
  // dates (also inside model ids like gpt-4o-2024-08-06), IPv4 addresses,
  // plain decimals and coordinates, and Unix timestamps (s or ms).
  exclude_patterns: [
    "^(?:\\d{4}[-.]\\d{1,2}[-.]\\d{1,2}|\\d{1,2}[-.]\\d{1,2}[-.]\\d{4})$",
    "^\\d{1,3}(?:\\.\\d{1,3}){3}$",
    "^\\d+\\.\\d+$",
    "^1[5-9]\\d{8}(?:\\d{3})?$",
  ] as string[],
};

// Shared pieces for "key = value" credential patterns. Values are masked
// only when they look like data, not code: references such as
// `os.environ[...]`, `${VAR}`, `<placeholder>`, plain lower-case words
// (`string`, `required`, `none`), and function calls stay visible.
const CODE_REF = "(?!(?:os|process|env|self|this|config|settings|window|request|req|ctx|import)[.\\[]|\\$|%|\\{\\{|<)";
const NOT_PLAIN_WORD = "(?![a-z_]+(?:[\\s\"',;&)\\]}>]|$))";
const NOT_CALL = "(?![^\\s\"',;&]*\\()";
const UNQUOTED_VALUE = `${CODE_REF}${NOT_PLAIN_WORD}${NOT_CALL}[^\\s"',;&]`;
const QUOTED_VALUE = "(?!\\$\\{|\\{\\{|<)[^\"'\\r\\n]";
const PASSWORD_KEY = "(?:[Pp]ass(?:word|wd|phrase)|PASS(?:WORD|WD|PHRASE)|[_-][Ss]ecret|[_-]SECRET)";
// Any identifier whose last word names a credential: `api_key`,
// `STRIPE_WEBHOOK_SECRET`, `x-api-key`, `accessToken`, `client.secret`,
// `db_password`, `credentials`, `session_id`. The leading lookbehind keeps
// `monkey`/`hotkey` from matching, and the value still has to pass
// `credential_shape`, so unknown credential formats are caught by context
// rather than by vendor prefix.
const CREDENTIAL_WORD_LOWER = "(?:key|apikey|token|secret|pass(?:word|wd|phrase)?|credentials?|auth|signature|cookie|session(?:[_-]?id)?|pat)";
const CREDENTIAL_WORD_UPPER = "(?:KEY|APIKEY|TOKEN|SECRET|PASS(?:WORD|WD|PHRASE)?|CREDENTIALS?|AUTH|SIGNATURE|COOKIE|SESSION(?:_?ID)?|PAT)";
const CREDENTIAL_WORD_CAP = "(?:Key|Token|Secret|Pass(?:word|wd|phrase)?|Credentials?|Auth|Signature|Cookie|Session(?:Id)?)";
const CREDENTIAL_KEY =
  `(?<![A-Za-z0-9])(?:[A-Za-z0-9]+[_.-])*(?:${CREDENTIAL_WORD_LOWER}|${CREDENTIAL_WORD_UPPER}|(?:[a-z][A-Za-z0-9]*)?${CREDENTIAL_WORD_CAP})`;
const KEY_SEPARATOR = "\\s*(?:=>|[:=])\\s*";

const RedactionConfigSchema = z.object({
  patterns: z.array(PatternSchema).default([]),
  heuristics: z
    .object({
      high_entropy: EntropyHeuristicSchema,
      // Pattern files written before digit_run existed omit it; treat a
      // missing block as the default rather than silently disabling it.
      digit_run: DigitRunHeuristicSchema.default(DEFAULT_DIGIT_RUN),
    })
    .default({
      high_entropy: {
        enabled: true,
        min_length: 16,
        min_entropy: 4.0,
        char_class: "[A-Za-z0-9_=+/.-]",
        exclude_patterns: [],
      },
      digit_run: DEFAULT_DIGIT_RUN,
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
      name: "github_fine_grained_token",
      regex: "github_pat_[A-Za-z0-9_]{50,}",
      type_hint: "github_token",
      enabled: true,
    },
    {
      name: "gitlab_token",
      regex: "glpat-[A-Za-z0-9_-]{20,}",
      type_hint: "gitlab_token",
      enabled: true,
    },
    {
      name: "slack_token",
      regex: "xox[abposr]-[A-Za-z0-9-]{10,}",
      type_hint: "slack_token",
      enabled: true,
    },
    {
      name: "stripe_key",
      regex: "\\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}",
      type_hint: "stripe_key",
      enabled: true,
    },
    {
      name: "google_api_key",
      regex: "AIza[A-Za-z0-9_-]{35}",
      type_hint: "google_api_key",
      enabled: true,
    },
    {
      name: "npm_token",
      regex: "\\bnpm_[A-Za-z0-9]{36}\\b",
      type_hint: "npm_token",
      enabled: true,
    },
    {
      name: "huggingface_token",
      regex: "\\bhf_[A-Za-z0-9]{30,}\\b",
      type_hint: "huggingface_token",
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
      name: "basic_auth_header",
      regex: "(?<=[Aa]uthorization[\"']?\\s*:\\s*[\"']?[Bb]asic\\s+)[A-Za-z0-9+/]{8,}={0,2}",
      type_hint: "basic_auth",
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
    // Credential assignments mask only the value (lookbehind keeps the key
    // visible) so the model still knows what kind of value was held back.
    // `pwd` is left out on purpose: it is the shell working-directory
    // command and shows up constantly in tool output.
    {
      name: "password_quoted",
      regex: `(?<=${PASSWORD_KEY}["']?\\s*[:=]\\s*["'])${QUOTED_VALUE}{3,}(?=["'])`,
      type_hint: "password",
      enabled: true,
    },
    {
      name: "password_assignment",
      regex: `(?<=${PASSWORD_KEY}\\s*[:=]\\s*)${UNQUOTED_VALUE}{3,}`,
      type_hint: "password",
      enabled: true,
    },
    {
      name: "password_phrase",
      regex: "(?<=\\b(?:[Pp]ass(?:word|phrase|code)|PASSWORD)\\s+(?:is|was)\\s+)(?![a-z]+\\b)[^\\s\"',;]{4,}(?<!\\.)",
      type_hint: "password",
      enabled: true,
    },
    {
      name: "credential_quoted",
      regex: `(?<=${CREDENTIAL_KEY}["']?${KEY_SEPARATOR}["'])[^"'\\r\\n]{8,}(?=["'])`,
      type_hint: "credential",
      validator: "credential_shape",
      enabled: true,
    },
    {
      name: "credential_assignment",
      regex: `(?<=${CREDENTIAL_KEY}${KEY_SEPARATOR})[^\\s"',;&<>(){}\\[\\]]{8,}`,
      type_hint: "credential",
      validator: "credential_shape",
      enabled: true,
    },
    {
      name: "pin_code",
      regex: "(?<=\\b(?:PIN|[Pp]in [Cc]ode|PIN [Cc]ode|[Pp]asscode|CVV|CVC|[Cc]vv|[Cc]vc|[Ss]ecurity [Cc]ode)(?:\\s+(?:is|was))?\\s*[:=#]?\\s*)\\d{3,8}\\b",
      type_hint: "pin",
      enabled: true,
    },
    {
      name: "labelled_private_key",
      regex: "(?<=\\b(?:[Pp]rivate[ _-]?[Kk]ey|PRIVATE_KEY|[Ss]eed)\\W{0,4}(?:0x)?)[a-fA-F0-9]{64}\\b",
      type_hint: "private_key",
      enabled: true,
    },
    {
      name: "us_phone",
      regex: "\\(\\d{3}\\)\\s?\\d{3}[-.\\s]\\d{4}\\b",
      type_hint: "phone",
      enabled: true,
    },
    {
      name: "bank_account",
      regex: "(?<=\\b(?:[Kk]onto(?:nummer|nr\\.?)?|[Bb]ank [Aa]ccount(?: [Nn]o\\.?| [Nn]umber)?|[Aa]ccount [Nn](?:o\\.?|umber))\\s*[:#]?\\s*)\\d[\\d -]{5,}\\d",
      type_hint: "bank_account",
      enabled: true,
    },
    {
      name: "passport_number",
      regex: "(?<=\\b[Pp]assport\\s*(?:(?:[Nn]o\\.?|[Nn]umber|#)\\s*)?[:#]?\\s*)(?=[A-Z]*\\d)[A-Z0-9]{6,9}\\b",
      type_hint: "passport_number",
      enabled: true,
    },
    {
      name: "url_credentials",
      regex: "(?<=\\b[A-Za-z][A-Za-z0-9+.-]*://[^\\s:/@]+:)[^\\s@/]+(?=@)",
      type_hint: "url_password",
      enabled: true,
    },
  ],
  heuristics: {
    high_entropy: {
      enabled: true,
      // 16 chars is the smallest length at which a random alphanumeric
      // string can clear `min_entropy: 4.0` (max entropy of a length-N
      // string is log2(N), so length-10 maxes at ~3.32 bits). Numeric-only
      // secrets are handled separately by the digit_run heuristic below.
      min_length: 16,
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
        // Prefixed object ids (`cus_…`, `msg_…`, `call_…`, `toolu_…`) are
        // up to 24 chars after the prefix. Longer prefixed values are
        // treated as tokens, which covers credential formats with an
        // unknown vendor prefix.
        "^[a-z]{2,8}_[A-Za-z0-9]{14,24}$",
      ],
    },
    digit_run: DEFAULT_DIGIT_RUN,
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

  cache = { config: upgradeLegacyDefaults(withMissingDefaultPatterns(result.data)), mtimeMs };
  return cache.config;
}

// Entropy excludes that earlier versions wrote into pattern files, mapped to
// their current form. Only exact copies of a retired default are replaced;
// excludes the user wrote are left alone.
const LEGACY_ENTROPY_EXCLUDES: Record<string, string> = {
  "^[a-f0-9]{40}$": "^(?:\\w+=)?[a-f0-9]{40}$",
  "^[a-f0-9]{64}$": "^(?:\\w+=)?[a-f0-9]{64}$",
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$":
    "^(?:\\w+=)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  "^[0-9A-HJKMNP-TV-Z]{26}$": "^(?:\\w+=)?[0-9A-HJKMNP-TV-Z]{26}$",
  // Hid every prefixed token, including credentials with unknown prefixes.
  "^[a-z]{2,8}_[A-Za-z0-9]{14,}$": "^[a-z]{2,8}_[A-Za-z0-9]{14,24}$",
};

function upgradeLegacyDefaults(config: RedactionConfig): RedactionConfig {
  const excludes = config.heuristics.high_entropy.exclude_patterns;
  if (!excludes.some((p) => p in LEGACY_ENTROPY_EXCLUDES)) return config;
  return {
    ...config,
    heuristics: {
      ...config.heuristics,
      high_entropy: {
        ...config.heuristics.high_entropy,
        exclude_patterns: excludes.map((p) => LEGACY_ENTROPY_EXCLUDES[p] ?? p),
      },
    },
  };
}

// A pattern file is a snapshot of the defaults at the time it was written,
// so built-in patterns added later would never apply. Append any default
// pattern whose name is absent; users turn one off with `enabled: false`.
function withMissingDefaultPatterns(config: RedactionConfig): RedactionConfig {
  const names = new Set(config.patterns.map((p) => p.name));
  const missing = DEFAULT_REDACTION_CONFIG.patterns.filter((p) => !names.has(p.name));
  return missing.length === 0 ? config : { ...config, patterns: [...config.patterns, ...missing] };
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
