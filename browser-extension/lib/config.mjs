// Shared config schema for the Jarela browser extension.
//
// `chrome.storage.local` persists a single key (`jarelaConfig`) holding
// `{ scheme, host, port }`. Both the service worker (background.js) and
// the options page (options.js) import this module so validation, defaults,
// and URL building stay in one place. Vitest exercises the pure logic.

export const STORAGE_KEY = "jarelaConfig";

export const DEFAULT_CONFIG = Object.freeze({
  scheme: "http",
  host: "127.0.0.1",
  port: 4312,
  preferPwa: true,
  autoOpen: false,
});

// Reject anything that isn't a bare hostname or IPv4 literal. The user
// could otherwise paste a full URL ("http://foo:1234/bar") and we'd
// happily build a nonsense origin from it. We deliberately do not accept
// IPv6 bracket form — the extension targets the local Jarela server which
// listens on IPv4 / hostname; revisit if that changes.
export function isValidHost(s) {
  if (typeof s !== "string") return false;
  const v = s.trim();
  if (v.length === 0 || v.length > 253) return false;
  if (/[/\s:?#]/.test(v)) return false;
  // IPv4 dotted-quad
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) {
    return v.split(".").every((oct) => {
      const n = Number(oct);
      return n >= 0 && n <= 255;
    });
  }
  // Hostname labels (RFC 1123 relaxed: allow digit-only labels for tailscale).
  return v.split(".").every((label) =>
    label.length >= 1 && label.length <= 63 &&
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(label)
  );
}

export function isValidPort(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

export function isValidScheme(s) {
  return s === "http" || s === "https";
}

// Coerce a possibly-untrusted value (from storage, options form, message)
// into a valid config object, falling back to defaults field-by-field.
export function parseConfig(raw) {
  const out = { ...DEFAULT_CONFIG };
  if (raw && typeof raw === "object") {
    if (isValidScheme(raw.scheme)) out.scheme = raw.scheme;
    if (isValidHost(raw.host)) out.host = String(raw.host).trim();
    if (isValidPort(raw.port)) out.port = Number(raw.port);
    if (typeof raw.preferPwa === "boolean") out.preferPwa = raw.preferPwa;
    if (typeof raw.autoOpen === "boolean") out.autoOpen = raw.autoOpen;
  }
  return out;
}

export function buildBase(cfg) {
  const c = parseConfig(cfg);
  // Omit the port from the URL when it matches the scheme default — keeps
  // the visible origin tidy on the options page and matches what the
  // browser would canonicalize the URL to anyway.
  const portPart =
    (c.scheme === "http" && c.port === 80) ||
    (c.scheme === "https" && c.port === 443)
      ? ""
      : `:${c.port}`;
  return `${c.scheme}://${c.host}${portPart}`;
}

export function healthUrl(cfg) { return `${buildBase(cfg)}/api/v1/health`; }
export function captureUrl(cfg) { return `${buildBase(cfg)}/api/v1/page-capture`; }
export function extensionRefineUrl(cfg) { return `${buildBase(cfg)}/api/v1/extension/refine`; }
export function extensionFillUrl(cfg) { return `${buildBase(cfg)}/api/v1/extension/fill`; }
export function extensionTurnUrl(cfg) { return `${buildBase(cfg)}/api/v1/extension/turn`; }
export function extensionAgentsUrl(cfg) { return `${buildBase(cfg)}/api/v1/extension/agents`; }
export function allowedSitesUrl(cfg) { return `${buildBase(cfg)}/api/v1/allowed-sites`; }
export function allowedSiteHostUrl(cfg, hostname) {
  return `${buildBase(cfg)}/api/v1/allowed-sites/${encodeURIComponent(hostname)}`;
}
export function appUrl(cfg) { return `${buildBase(cfg)}/`; }

// Origin match patterns to request via chrome.permissions.request(). We
// always request both `127.0.0.1` and `localhost` when one of them is set
// — they're the same target and users routinely type either.
export function buildOriginPatterns(cfg) {
  return buildOrigins(cfg).map((o) => `${o}/*`);
}

// Plain origins (no path suffix) — used both by buildOriginPatterns and by
// the PWA launcher to compare against `chrome.management.ExtensionInfo`'s
// `appLaunchUrl` so we can match an installed PWA to the configured
// Jarela server even when the user typed the loopback twin.
export function buildOrigins(cfg) {
  const c = parseConfig(cfg);
  const portPart =
    (c.scheme === "http" && c.port === 80) ||
    (c.scheme === "https" && c.port === 443)
      ? ""
      : `:${c.port}`;
  const out = new Set([`${c.scheme}://${c.host}${portPart}`]);
  if (c.host === "127.0.0.1") out.add(`${c.scheme}://localhost${portPart}`);
  if (c.host === "localhost") out.add(`${c.scheme}://127.0.0.1${portPart}`);
  return [...out];
}

// True when `launchUrl` (typically a PWA's `appLaunchUrl` or `homepageUrl`)
// points at the same origin as the configured Jarela server, accounting
// for the 127.0.0.1 ⇄ localhost equivalence.
export function matchesLaunchUrl(cfg, launchUrl) {
  if (typeof launchUrl !== "string" || launchUrl.length === 0) return false;
  let parsed;
  try { parsed = new URL(launchUrl); } catch { return false; }
  return buildOrigins(cfg).includes(parsed.origin);
}
