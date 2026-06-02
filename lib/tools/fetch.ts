import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { stripHtml } from "@/lib/utils/html";
import { checkPublicUrl } from "@/lib/utils/private-ip";
import { registerTools } from "./registry";
import { networkErrorCode } from "./error-codes";

const MAX_BYTES = 200_000;
const TIMEOUT_MS = 15_000;
// Defense against SSRF redirect chains: every Location-hop is re-checked
// against the SSRF policy. Cap the chain so a malicious server can't
// pin us in a redirect loop.
const MAX_REDIRECTS = 5;

function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return m ? m[1].trim() : null;
}

// Pull image URLs out of a fetched page so the agent can embed them in its
// reply via standard markdown `![alt](url)`. We expose three categories:
//   - og: the page's primary OG image (most useful — chosen by the publisher)
//   - twitter: the Twitter card image (close second)
//   - samples: the first few <img src=…> tags (fallback when meta is missing)
//
// All URLs are resolved to absolute against the final fetched URL so the
// agent can use them as-is. Data URIs and tracking pixels are filtered out.
function extractImages(html: string, baseUrl: string): {
  og: string | null;
  twitter: string | null;
  samples: string[];
} {
  const og =
    /<meta[^>]+property=["']og:image(?::secure_url|:url)?["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] ??
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(html)?.[1] ?? null;

  const twitter =
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] ??
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i.exec(html)?.[1] ?? null;

  const seen = new Set<string>();
  const samples: string[] = [];
  for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    const src = m[1];
    if (!src || src.startsWith("data:")) continue;
    // Skip obvious tracking pixels and tiny svgs.
    if (/(?:1x1|pixel|spacer)\.(?:gif|png)/i.test(src)) continue;
    const abs = resolveUrl(src, baseUrl);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    samples.push(abs);
    if (samples.length >= 6) break;
  }

  return {
    og: resolveUrl(og, baseUrl),
    twitter: resolveUrl(twitter, baseUrl),
    samples,
  };
}

function resolveUrl(u: string | null | undefined, base: string): string | null {
  if (!u) return null;
  try { return new URL(u, base).toString(); } catch { return null; }
}

export const webFetchTool = tool(
  async ({ url, mode, max_chars }) => {
    if (!/^https?:\/\//.test(url)) {
      return JSON.stringify({ error: "url must start with http:// or https://", code: "invalid_args" });
    }
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      // SSRF guard. The LLM controls `url`, and our HTTP middleware
      // treats loopback callers as the host machine's admin user — a
      // prompt-injected page could otherwise ask the agent to fetch
      // http://127.0.0.1:4312/api/v1/... and elevate. Same story for
      // 169.254.169.254 (cloud metadata) and the RFC1918 ranges.
      // Operators with a legitimate intranet need can opt back in via
      // JARELA_ALLOW_PRIVATE_FETCH=1.
      const initialCheck = await checkPublicUrl(url);
      if (!initialCheck.allowed) {
        return JSON.stringify({
          url,
          error: `Refused to fetch private/loopback address (${initialCheck.reason}). Set JARELA_ALLOW_PRIVATE_FETCH=1 to override.`,
          code: "ssrf_blocked",
        });
      }

      // Manual redirect chasing so each hop is re-checked against the
      // SSRF policy. A 30x to an attacker-controlled host could otherwise
      // bounce us into 169.254.x even though the initial URL looked
      // public.
      let currentUrl = url;
      let res: Response;
      for (let hop = 0; ; hop++) {
        res = await fetch(currentUrl, {
          signal: ctrl.signal,
          redirect: "manual",
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
        });
        if (res.status < 300 || res.status >= 400) break;
        const loc = res.headers.get("location");
        if (!loc) break;
        if (hop >= MAX_REDIRECTS) {
          return JSON.stringify({ url: currentUrl, error: `too many redirects (>${MAX_REDIRECTS})`, code: "redirect_limit" });
        }
        let next: string;
        try {
          next = new URL(loc, currentUrl).toString();
        } catch {
          return JSON.stringify({ url: currentUrl, error: `invalid redirect target: ${loc}`, code: "invalid_redirect" });
        }
        const hopCheck = await checkPublicUrl(next);
        if (!hopCheck.allowed) {
          return JSON.stringify({
            url: next,
            error: `Refused redirect to private/loopback address (${hopCheck.reason}).`,
            code: "ssrf_blocked",
          });
        }
        currentUrl = next;
      }

      const contentType = res.headers.get("content-type") ?? "";
      const finalUrl = res.url || currentUrl;
      // Read up to MAX_BYTES so a 5MB page doesn't blow the agent's context.
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let bytesRead = 0;
      let raw = "";
      if (reader) {
        while (bytesRead < MAX_BYTES) {
          const { value, done } = await reader.read();
          if (done) break;
          bytesRead += value.byteLength;
          raw += decoder.decode(value, { stream: true });
          if (bytesRead >= MAX_BYTES) {
            await reader.cancel();
            break;
          }
        }
      }
      const truncated = bytesRead >= MAX_BYTES;
      const cap = max_chars ?? 8000;
      const wantHtml = mode === "html";
      const title = extractTitle(raw);
      const body = wantHtml ? raw : stripHtml(raw);
      const clipped = body.length > cap ? body.slice(0, cap) + "…" : body;
      const images = extractImages(raw, finalUrl);

      return JSON.stringify({
        url: finalUrl,
        status: res.status,
        content_type: contentType,
        title,
        mode: wantHtml ? "html" : "text",
        bytes_read: bytesRead,
        truncated,
        content: clipped,
        images,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Distinguish abort (timeout / upstream cancel) from arbitrary network
      // failure so the agent's playbook fires the right branch — timeouts
      // mean "narrow the input"; network errors are transient and worth
      // retrying once with the same args.
      const aborted = (err as { name?: string })?.name === "AbortError";
      const code = aborted ? "tool_timeout" : (networkErrorCode(err) ?? "fetch_error");
      return JSON.stringify({ url, error: msg, code });
    } finally {
      clearTimeout(timeout);
    }
  },
  {
    name: "web_fetch",
    description:
      "Fetch the content of a URL. Default mode='text' returns extracted plain text (good for summarizing articles). " +
      "mode='html' returns raw HTML if you specifically need markup. Truncates after 200KB. " +
      "Use this when web_search returns a URL but you need the actual page content, or to fetch a specific known page. " +
      "The response also includes an `images` object with absolute URLs extracted from the page: " +
      "`og` (og:image — usually the best hero image), `twitter` (twitter:image), and `samples` (first few <img> tags). " +
      "Embed these in your reply with markdown `![alt](url)` to produce rich, image-rich answers.",
    schema: z.object({
      url: z.string().describe("Absolute URL starting with http:// or https://"),
      mode: z.enum(["text", "html"]).optional().describe("'text' (default) extracts readable text; 'html' returns raw markup"),
      max_chars: z.number().optional().describe("Max characters to return after extraction (default 8000)"),
    }),
  },
);

registerTools("Web", "read", [webFetchTool]);
