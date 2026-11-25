// Documented browser-cache exception for non-durable UI preferences.
//
// Persistent application state belongs in lib/stores. A few UI preferences
// (theme, experience mode, currency, banner dismissal, notification cursor,
// display filters, first-run markers) are intentionally browser-local caches.
// Route every React-side read/write through this module so the exception is
// auditable and SSR/quota failures are handled consistently. The only direct
// reader is the pre-paint theme script in app/layout.tsx, which must run before
// this module can load.

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readBrowserValue(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeBrowserValue(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Quota or privacy-mode failures leave the preference at its default.
  }
}

export function removeBrowserValue(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Best effort; a failed removal cannot corrupt in-memory state.
  }
}
