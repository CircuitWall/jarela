// Where the Jarela app itself is served.
//
// The browser tools must not steer the tab the user is having the conversation
// in: navigating, filling, or clicking there mutates the app's own UI and can
// close the chat. The extension knows this origin exactly (it computes it from
// its own server config), but the server had no equivalent, so a tool could
// only find out after the round trip — or not at all for actions the extension
// does not guard.
//
// This resolves the same origin server-side: an explicit JARELA_PUBLIC_URL
// when the app is served on a non-loopback address, otherwise the loopback
// defaults Jarela listens on.

const DEFAULT_PORT = "4312";

function parseOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin.toLowerCase();
  } catch {
    return null;
  }
}

/** Every origin the app can be reached on, most specific first. */
export function getAppOrigins(): string[] {
  const out = new Set<string>();
  const explicit = parseOrigin(process.env.JARELA_PUBLIC_URL);
  if (explicit) out.add(explicit);
  const port = process.env.PORT?.trim() || DEFAULT_PORT;
  out.add(`http://localhost:${port}`);
  out.add(`http://127.0.0.1:${port}`);
  return [...out];
}

/** True when `url` points at the Jarela app itself. */
export function isAppOrigin(url: string | undefined): boolean {
  const origin = parseOrigin(url);
  if (!origin) return false;
  return getAppOrigins().includes(origin);
}
