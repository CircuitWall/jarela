// Local-file link classification and the one call that hands a file to the
// operating system's default app (Windows via Start-Process, macOS via `open`,
// Linux via xdg-open — see app/api/v1/local-file/route.ts).

const LOCALHOST_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * A markdown href that points at a file on this machine rather than a web
 * page or an in-app route. Deliberately permissive: it is only used to route
 * a link to the file preview instead of navigating the app.
 */
export function isLikelyLocalFileHref(href: string): boolean {
  if (!href || href.startsWith("#")) return false;
  if (/^(mailto|tel|javascript|data|blob):/i.test(href)) return false;
  if (/^file:\/\//i.test(href)) return true;
  if (/^[A-Za-z]:[\\/]/.test(href) || href.startsWith("~/") || href.startsWith("~\\")) return true;
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      if (!LOCALHOST_NAMES.has(url.hostname)) return false;
      return !/^\/(api|_next)(\/|$)/.test(url.pathname);
    } catch {
      return false;
    }
  }
  if (href.startsWith("/")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
  return /(^\.\.?[\\/]|[\\/]|\.[A-Za-z0-9]{1,12}(?:[?#]|$))/.test(href);
}

/**
 * Stricter than {@link isLikelyLocalFileHref}: used for bare strings scraped
 * out of references and tool output, where "example.com" must not become an
 * open-file action. Requires a path separator, a Windows drive, a home path,
 * or a file:// scheme.
 */
export function isLocalFilePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  // A trailing separator usually marks a directory, which the open endpoint
  // rejects ("path is not a file"); keep that out of linkified output.
  if (/[\\/]$/.test(trimmed) && !/^[A-Za-z]:[\\/]$/.test(trimmed)) return false;
  if (/^(mailto|tel|javascript|data|blob):/i.test(trimmed)) return false;
  if (/^file:\/\//i.test(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false;
  if (/^\/(api|_next)(\/|$)/.test(trimmed) || trimmed.startsWith("/?")) return false;
  return trimmed.includes("/") || trimmed.includes("\\");
}

/**
 * File-looking token inside free-form text (tool transcripts, step lists).
 * Stricter still: needs an extension or an explicit drive/home/file prefix so
 * prose like "and/or" or "src/app" is not turned into an open-file action.
 */
export function isLocalFileToken(value: string): boolean {
  const trimmed = value.trim();
  if (!isLocalFilePath(trimmed)) return false;
  if (/^file:\/\//i.test(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return true;
  return /\.[A-Za-z0-9]{1,12}$/.test(trimmed.replace(/[?#].*$/, ""));
}

/** Ask the local server to open `href` with the OS default program. */export async function openLocalFile(href: string, threadId?: string | null): Promise<void> {
  const res = await fetch("/api/v1/local-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ href, thread_id: threadId ?? undefined }),
  });
  if (res.ok) return;
  const body = await res.json().catch(() => ({} as { error?: unknown }));
  throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
}
