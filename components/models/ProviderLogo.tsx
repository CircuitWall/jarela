import type { CSSProperties } from "react";
import {
  siAnthropic,
  siDeepseek,
  siGithub,
  siGooglegemini,
  siLangchain,
  siMistralai,
  siOllama,
  siPerplexity,
  siX,
  type SimpleIcon,
} from "simple-icons";

// Map Jarela provider slugs → CC0 brand-mark SVGs from simple-icons. We use
// the path data only and force currentColor for a monochrome look that
// tracks the surrounding text color.
const ICONS: Record<string, SimpleIcon> = {
  anthropic: siAnthropic,
  gemini: siGooglegemini,
  google: siGooglegemini,
  "github-copilot": siGithub,
  github: siGithub,
  deepseek: siDeepseek,
  mistral: siMistralai,
  ollama: siOllama,
  langchain: siLangchain,
  perplexity: siPerplexity,
  xai: siX,
  grok: siX,
};

// Two-letter monograms for providers simple-icons doesn't ship a brand mark
// for (e.g. OpenAI and Cohere had their icons removed at brand request).
const FALLBACK_INITIALS: Record<string, string> = {
  openai: "Ai",
  cohere: "Co",
  groq: "Gq",
  mock: "\u00b7\u00b7",
};

function initialsFor(name: string): string {
  if (FALLBACK_INITIALS[name]) return FALLBACK_INITIALS[name];
  const trimmed = name.replace(/^[^a-z0-9]+/i, "");
  return (trimmed.slice(0, 2) || "·").toLowerCase();
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
