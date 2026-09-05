// Ephemeral record of the page the user is looking at right now.
//
// The browser extension pushes this while its side panel is open (see
// ADR-0082). It is deliberately process-local and TTL'd rather than a
// row in ~/.jarela: it describes where the user is *at this moment*, so
// surviving a restart would only ever produce a stale claim. Losing it
// costs nothing — the next tab activation re-establishes it.
//
// URL, title and host only. Page content never enters this store; the
// agent must call a browser tool to read a page.

export interface ForegroundTabPresence {
  url: string;
  title: string;
  host: string;
  tab_id: number | null;
  /** When the extension observed the tab, in epoch ms. */
  recorded_at: number;
  /** When the server accepted the push, in epoch ms. */
  received_at: number;
}

/** Presence older than this is treated as unknown rather than reported. */
export const FOREGROUND_PRESENCE_TTL_MS = 5 * 60_000;

let current: ForegroundTabPresence | null = null;

export function setForegroundTabPresence(
  input: Omit<ForegroundTabPresence, "received_at">,
): ForegroundTabPresence {
  current = { ...input, received_at: Date.now() };
  return current;
}

export function getForegroundTabPresence(now: number = Date.now()): ForegroundTabPresence | null {
  if (!current) return null;
  if (now - current.received_at > FOREGROUND_PRESENCE_TTL_MS) return null;
  return current;
}

export function clearForegroundTabPresence(): void {
  current = null;
}
