import type { CSSProperties } from "react";
import { Mail, type LucideIcon } from "lucide-react";
import {
  siAnthropic,
  siApple,
  siAtlassian,
  siDeepseek,
  siDiscord,
  siGithub,
  siGmail,
  siGooglegemini,
  siJira,
  siLangchain,
  siMessenger,
  siMistralai,
  siOllama,
  siPerplexity,
  siSignal,
  siTelegram,
  siWhatsapp,
  siX,
  type SimpleIcon,
} from "simple-icons";

// Map Jarela provider slugs → CC0 brand-mark SVGs from simple-icons. We use
// the path data only and force currentColor for a monochrome look that
// tracks the surrounding text color.
//
// Covers LLM providers, credential integrations, and bridge kinds — any
// surface that represents a third-party brand should render through here
// so the icon stays consistent.
const ICONS: Record<string, SimpleIcon> = {
  anthropic: siAnthropic,
  atlassian: siAtlassian,
  discord: siDiscord,
  gemini: siGooglegemini,
  google: siGooglegemini,
  "github-copilot": siGithub,
  github: siGithub,
  gmail: siGmail,
  deepseek: siDeepseek,
  icloud: siApple,
  jira: siJira,
  jira_align: siJira,
  messenger: siMessenger,
  mistral: siMistralai,
  ollama: siOllama,
  langchain: siLangchain,
  perplexity: siPerplexity,
  signal: siSignal,
  telegram: siTelegram,
  whatsapp: siWhatsapp,
  xai: siX,
  grok: siX,
};

// Lucide stand-ins for providers simple-icons no longer ships a brand mark
// for. Microsoft pulled Outlook/Microsoft/Office from simple-icons at brand
// request, so we use a generic envelope glyph that still reads as "mail" in
// the credentials list.
const LUCIDE_ICONS: Record<string, LucideIcon> = {
  outlook: Mail,
};

// Two-letter monograms for providers we have neither a brand mark nor a
// sensible lucide stand-in for (e.g. OpenAI, Cohere had their icons removed
// at brand request).
const FALLBACK_INITIALS: Record<string, string> = {
  openai: "Ai",
  cohere: "Co",
  groq: "Gq",
  microsoft: "Ms",
  mock: "\u00b7\u00b7",
};

function initialsFor(name: string): string {
  if (FALLBACK_INITIALS[name]) return FALLBACK_INITIALS[name];
  const trimmed = name.replace(/^[^a-z0-9]+/i, "");
  return (trimmed.slice(0, 2) || "·").toLowerCase();
}

// Slugs we know how to render a brand glyph (or branded monogram) for.
// Sorted longest-first so multi-segment slugs like `jira_align` beat the
// shorter `jira` when we prefix-match a tool name.
export const KNOWN_BRAND_SLUGS: readonly string[] = Object.keys({
  ...ICONS,
  ...LUCIDE_ICONS,
  ...FALLBACK_INITIALS,
})
  .filter((s) => s !== "mock")
  .sort((a, b) => b.length - a.length);

// Alias map: some tool families use a shorter brand prefix than the
// canonical simple-icons slug we render logos for. Register the short
// prefix here and the resolver will return the canonical slug so both
// `<ProviderLogo>` and `provider-grouping` treat them as the same brand.
// Currently:
//   - `ms_todo_*`, `ms_graph_*`, `ms_search`, `ms_people_resolve` belong
//     to the Microsoft brand (canonical slug `microsoft`).
//   - `calendar_*` are the bare-prefixed Google Calendar tools (Outlook
//     and iCloud carry `outlook_calendar_*` / `icloud_calendar_*` and
//     already group via their own slug); alias `calendar` → `google` so
//     they render in the Google box instead of falling into Other.
const BRAND_ALIASES: Record<string, string> = {
  ms: "microsoft",
  calendar: "google",
};

const BRAND_ALIAS_KEYS: readonly string[] = Object.keys(BRAND_ALIASES).sort(
  (a, b) => b.length - a.length,
);

/**
 * Recognize a third-party brand from an underscore-separated tool name.
 *
 * Tool names follow the convention `<brand>_<verb>_<noun>` (e.g.
 * `gmail_send_email`, `github_create_issue`, `jira_align_list_objectives`).
 * Returns the matching `ProviderLogo` slug if the prefix is one we have
 * an icon for, otherwise `null` — callers should fall back to a generic
 * tool icon.
 */
export function brandSlugForToolName(name: string): string | null {
  const lower = name.toLowerCase();
  for (const slug of KNOWN_BRAND_SLUGS) {
    if (lower === slug || lower.startsWith(slug + "_")) return slug;
  }
  for (const alias of BRAND_ALIAS_KEYS) {
    if (lower === alias || lower.startsWith(alias + "_")) return BRAND_ALIASES[alias]!;
  }
  return null;
}

export function ProviderLogo({
  name,
  size = 16,
  className = "",
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const icon = ICONS[name];
  if (icon) {
    return (
      <svg
        role="img"
        aria-label={name}
        viewBox="0 0 24 24"
        width={size}
        height={size}
        className={`inline-block shrink-0 ${className}`}
        fill="currentColor"
      >
        <title>{name}</title>
        <path d={icon.path} />
      </svg>
    );
  }
  const Lucide = LUCIDE_ICONS[name];
  if (Lucide) {
    return (
      <Lucide
        aria-label={name}
        size={size}
        className={`inline-block shrink-0 ${className}`}
      />
    );
  }
  const initials = initialsFor(name);
  const style: CSSProperties = {
    width: size,
    height: size,
    fontSize: Math.max(8, Math.round(size * 0.46)),
    lineHeight: 1,
  };
  return (
    <span
      aria-label={name}
      title={name}
      style={style}
      className={`inline-flex items-center justify-center rounded-md border border-current bg-transparent font-semibold uppercase tracking-tight ${className}`}
    >
      {initials}
    </span>
  );
}
