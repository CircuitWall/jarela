// Branding knobs sourced from NEXT_PUBLIC_* env vars so forks can rebrand
// the app without patching source. NEXT_PUBLIC_* is the right
// channel here because Next.js inlines these at build time, which lets
// client components read them directly (no React Context, no server
// round-trip). Server-only modules read the same keys at runtime.
//
// Keep this module client-safe — no Node-only imports, no DB/FS access.
//
// IMPORTANT: every read below must spell out `process.env.NEXT_PUBLIC_X` as
// a literal member expression. Next.js performs a *textual* substitution at
// build time, so a computed lookup (`process.env[key]`) is left untouched
// and resolves to `undefined` in the browser bundle.

const DEFAULT_APP_NAME = "Jarela";
const DEFAULT_APP_DESCRIPTION = "Jarela — local chat interface for LangGraph agents";
const DEFAULT_ISSUE_URL = "https://github.com/CircuitWall/jarela/issues/new";
const DEFAULT_LOGO_LIGHT = "/logo-mark-transparent.png";
const DEFAULT_LOGO_DARK = "/logo-mark-transparent-dark.png";
const DEFAULT_ICONS = {
  faviconSvg: "/favicon.svg",
  faviconIco: "/favicon.ico",
  icon192: "/icon-192.png",
  icon512: "/icon-512.png",
  icon192Maskable: "/icon-192-maskable.png",
  icon512Maskable: "/icon-512-maskable.png",
  icon192Light: "/icon-192-light.png",
  icon512Light: "/icon-512-light.png",
  icon192MaskableLight: "/icon-192-maskable-light.png",
  icon512MaskableLight: "/icon-512-maskable-light.png",
  appleTouchIcon: "/apple-touch-icon.png",
} as const;

/**
 * Upstream project identity. Deliberately NOT overridable: rebranded
 * overlays still surface a "Powered by Jarela" credit, and upstream-facing
 * machinery (update checks, tool-telemetry issue drafts) keeps pointing
 * here. `getAppIssueUrl()` is the separate, overridable knob for a fork's
 * *own* bug tracker.
 *
 * @public
 */
export const UPSTREAM_NAME = "Jarela";

/** @public */
export const UPSTREAM_URL = "https://github.com/CircuitWall/jarela";

function pick(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

/** @public */
export function getAppName(): string {
  return pick(process.env.NEXT_PUBLIC_APP_NAME, DEFAULT_APP_NAME);
}

/**
 * PWA `short_name`. Falls back to the full app name, so an overlay only has
 * to set `NEXT_PUBLIC_APP_SHORT_NAME` when its name is too long for a
 * home-screen label.
 *
 * @public
 */
export function getAppShortName(): string {
  return pick(process.env.NEXT_PUBLIC_APP_SHORT_NAME, getAppName());
}

/** @public */
export function getAppDescription(): string {
  return pick(process.env.NEXT_PUBLIC_APP_DESCRIPTION, DEFAULT_APP_DESCRIPTION);
}

/** @public */
export function getAppIssueUrl(): string {
  return pick(process.env.NEXT_PUBLIC_APP_ISSUE_URL, DEFAULT_ISSUE_URL);
}

/**
 * In-app wordmark. Two variants so an overlay can supply marks tuned for
 * light and dark surfaces; the dark one falls back to the light one when a
 * fork ships only a single asset.
 *
 * @public
 */
export function getAppLogoLight(): string {
  return pick(process.env.NEXT_PUBLIC_APP_LOGO_LIGHT, DEFAULT_LOGO_LIGHT);
}

/** @public */
export function getAppLogoDark(): string {
  const dark = process.env.NEXT_PUBLIC_APP_LOGO_DARK?.trim();
  if (dark) return dark;
  const light = process.env.NEXT_PUBLIC_APP_LOGO_LIGHT?.trim();
  return light ? light : DEFAULT_LOGO_DARK;
}

/** @public */
export interface AppIcons {
  readonly faviconSvg: string;
  readonly faviconIco: string;
  readonly icon192: string;
  readonly icon512: string;
  readonly icon192Maskable: string;
  readonly icon512Maskable: string;
  readonly icon192Light: string;
  readonly icon512Light: string;
  readonly icon192MaskableLight: string;
  readonly icon512MaskableLight: string;
  readonly appleTouchIcon: string;
}

/**
 * Favicon / PWA icon set. An overlay that drops replacement files into
 * `public/` under the same names needs none of these; the env vars exist
 * for overlays that keep their assets on other paths or a CDN.
 *
 * @public
 */
export function getAppIcons(): AppIcons {
  return {
    faviconSvg: pick(process.env.NEXT_PUBLIC_APP_FAVICON_SVG, DEFAULT_ICONS.faviconSvg),
    faviconIco: pick(process.env.NEXT_PUBLIC_APP_FAVICON_ICO, DEFAULT_ICONS.faviconIco),
    icon192: pick(process.env.NEXT_PUBLIC_APP_ICON_192, DEFAULT_ICONS.icon192),
    icon512: pick(process.env.NEXT_PUBLIC_APP_ICON_512, DEFAULT_ICONS.icon512),
    icon192Maskable: pick(
      process.env.NEXT_PUBLIC_APP_ICON_192_MASKABLE,
      DEFAULT_ICONS.icon192Maskable,
    ),
    icon512Maskable: pick(
      process.env.NEXT_PUBLIC_APP_ICON_512_MASKABLE,
      DEFAULT_ICONS.icon512Maskable,
    ),
    icon192Light: pick(
      process.env.NEXT_PUBLIC_APP_ICON_192_LIGHT,
      DEFAULT_ICONS.icon192Light,
    ),
    icon512Light: pick(
      process.env.NEXT_PUBLIC_APP_ICON_512_LIGHT,
      DEFAULT_ICONS.icon512Light,
    ),
    icon192MaskableLight: pick(
      process.env.NEXT_PUBLIC_APP_ICON_192_MASKABLE_LIGHT,
      DEFAULT_ICONS.icon192MaskableLight,
    ),
    icon512MaskableLight: pick(
      process.env.NEXT_PUBLIC_APP_ICON_512_MASKABLE_LIGHT,
      DEFAULT_ICONS.icon512MaskableLight,
    ),
    appleTouchIcon: pick(
      process.env.NEXT_PUBLIC_APP_APPLE_TOUCH_ICON,
      DEFAULT_ICONS.appleTouchIcon,
    ),
  };
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function hexOrNull(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  // We inject this straight into a <style> block, so reject anything that
  // isn't a plain hex literal rather than passing it through.
  return HEX.test(v) ? v : null;
}

/**
 * Accent recolor for the overlay's brand color. `null` means "leave the
 * stylesheet alone".
 *
 * @public
 */
export function getAppAccentColor(): string | null {
  return hexOrNull(process.env.NEXT_PUBLIC_APP_ACCENT_COLOR);
}

/**
 * Hover shade for the accent. When the overlay sets only the base accent,
 * this derives a darker shade so hover states stay coherent.
 *
 * @public
 */
export function getAppAccentHoverColor(): string | null {
  const explicit = hexOrNull(process.env.NEXT_PUBLIC_APP_ACCENT_HOVER_COLOR);
  if (explicit) return explicit;
  const accent = getAppAccentColor();
  return accent ? darken(accent, 0.15) : null;
}

function darken(hex: string, amount: number): string {
  const full =
    hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex;
  const n = Number.parseInt(full.slice(1), 16);
  const clamp = (c: number) => Math.max(0, Math.min(255, Math.round(c * (1 - amount))));
  const r = clamp((n >> 16) & 0xff);
  const g = clamp((n >> 8) & 0xff);
  const b = clamp(n & 0xff);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
