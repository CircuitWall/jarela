import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { stripHtml } from "@/lib/utils/html";
import { checkPublicUrl } from "@/lib/utils/private-ip";
import { getCookieHeaderForUrl, isHostAllowed } from "@/lib/cookies/jar";
import { registerLangChainPackage } from "../packages/langchain-package";
import { getConfig } from "@/lib/env/config";
import { errorMessage } from "@/lib/utils/error";
import { readResponseTextCapped } from "@/lib/utils/http-json";
import { getDeepSeekWebApiKey, postDeepSeekWebTool } from "./deepseek";

const DeepSeekFetchResponseSchema = z.object({
  title: z.string(),
  content: z.string(),
});

// Whether the SSRF refusal for a private/loopback host should be
// overridden because the user explicitly approved this host (with
// ssrf_bypass=1) via the allowed-sites Settings panel. Lets the agent
// reach intranet/SSO sites the user logged into in their browser
// without flipping the global JARELA_ALLOW_PRIVATE_FETCH escape hatch.
function ssrfBypassedForUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    const m = isHostAllowed(host);
    return m.allowed && m.ssrfBypass;
  } catch {
    return false;
  }
}

// JARELA_FETCH_TOOL_MAX_BYTES overrides the byte cap.
function maxBytes(): number { return getConfig().fetchToolMaxBytes; }
// Internal cap on a single fetch. The agent's wall-clock budget on the
// tool call (see lib/tools/wallclock.ts) is the primary deadline; this is
// a leak backstop that actually closes the socket via AbortController so a
// stuck server can't tie up an fd indefinitely.
const FETCH_INTERNAL_TIMEOUT_MS = 120_000;
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

// Manual redirect chasing so each hop is re-checked against the SSRF
// policy. A 30x to an attacker-controlled host could otherwise bounce us
// into 169.254.x even though the initial URL looked public. Returns the
// final Response + URL, or an error JSON string for the tool to forward.
async function followRedirectsWithSsrfCheck(
  startUrl: string,
  signal: AbortSignal,
): Promise<{ res: Response; finalUrl: string } | { error: string }> {
  let currentUrl = startUrl;
  let res: Response;
  for (let hop = 0; ; hop++) {
    // Re-resolve cookies on every hop against the *current* URL's host.
    // A redirect off an allow-listed host strips the Cookie header so we
    // never leak intranet.example.com cookies to a redirect that lands
    // somewhere else.
    const cookieHeader = getCookieHeaderForUrl(currentUrl);
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    };
    if (cookieHeader) headers["Cookie"] = cookieHeader;
    res = await fetch(currentUrl, {
      signal,
      redirect: "manual",
      headers,
    });
    if (res.status < 300 || res.status >= 400) break;
    const loc = res.headers.get("location");
    if (!loc) break;
    if (hop >= MAX_REDIRECTS) {
      return { error: JSON.stringify({ url: currentUrl, error: `too many redirects (>${MAX_REDIRECTS})` }) };
    }
    let next: string;
    try { next = new URL(loc, currentUrl).toString(); }
    catch { return { error: JSON.stringify({ url: currentUrl, error: `invalid redirect target: ${loc}` }) }; }
    const hopCheck = await checkPublicUrl(next);
    if (!hopCheck.allowed && !ssrfBypassedForUrl(next)) {
      return { error: JSON.stringify({
        url: next,
        error: `Refused redirect to private/loopback address (${hopCheck.reason}).`,
      }) };
    }
    currentUrl = next;
  }
  return { res, finalUrl: res.url || currentUrl };
}

function formatFetchError(
  err: unknown,
  url: string,
  ctrl: AbortController,
  timeoutMs: number,
): string {
  const msg = errorMessage(err);
  const aborted = ctrl.signal.aborted
    || (err instanceof Error && (err.name === "AbortError" || /abort/i.test(msg)));
  if (aborted) {
    return JSON.stringify({
      url,
      error: `timed out after ${Math.round(timeoutMs / 1000)}s. The page is slow or unresponsive — try a different URL or pass a larger deadline_ms.`,
      timed_out: true,
      timeout_ms: timeoutMs,
    });
  }
  return JSON.stringify({ url, error: msg });
}

export const webFetchTool = tool(
  async ({ url, mode, max_chars }) => {
    if (!/^https?:\/\//.test(url)) {
      return JSON.stringify({ error: "url must start with http:// or https://" });
    }
    const ctrl = new AbortController();
    const TIMEOUT_MS = FETCH_INTERNAL_TIMEOUT_MS;
    const MAX_BYTES = maxBytes();
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
      if (!initialCheck.allowed && !ssrfBypassedForUrl(url)) {
        return JSON.stringify({
          url,
          error: `Refused to fetch private/loopback address (${initialCheck.reason}). Set JARELA_ALLOW_PRIVATE_FETCH=1 to override, or approve this host with SSRF bypass in Settings → Allowed sites.`,
        });
      }

      const deepSeekApiKey = getDeepSeekWebApiKey();
      // Preserve local authentication, HTML, and private-fetch behavior.
      if (
        deepSeekApiKey &&
        mode !== "html" &&
        !getConfig().allowPrivateFetch &&
        !isHostAllowed(new URL(url).hostname).allowed
      ) {
        if (Array.from(url).length > 8192) {
          return JSON.stringify({ url, error: "DeepSeek Fetch URLs must be at most 8192 characters." });
        }
        const parsedUrl = new URL(url);
        if (parsedUrl.username || parsedUrl.password) {
          return JSON.stringify({ url, error: "DeepSeek Fetch does not accept URLs containing a username or password." });
        }
        const payload = await postDeepSeekWebTool("fetch", deepSeekApiKey, { url }, ctrl.signal, TIMEOUT_MS);
        const parsed = DeepSeekFetchResponseSchema.safeParse(payload);
        if (!parsed.success) throw new Error("DeepSeek Fetch returned an invalid response.");
        const encodedContent = new TextEncoder().encode(parsed.data.content);
        if (encodedContent.length === 0) throw new Error("DeepSeek Fetch returned no page content.");
        const boundedContent = new TextDecoder().decode(encodedContent.subarray(0, MAX_BYTES));
        const cap = max_chars ?? 8000;
        const clipped = boundedContent.length > cap
          ? boundedContent.slice(0, cap) + "…"
          : boundedContent;
        return JSON.stringify({
          url,
          status: 200,
          title: parsed.data.title || null,
          content_type: "text/markdown",
          mode: "text",
          bytes_read: Math.min(encodedContent.length, MAX_BYTES),
          truncated: encodedContent.length > MAX_BYTES || boundedContent.length > cap,
          content: clipped,
          images: { og: null, twitter: null, samples: [] },
          fetcher: "deepseek",
        });
      }

      const hopResult = await followRedirectsWithSsrfCheck(url, ctrl.signal);
      if ("error" in hopResult) return hopResult.error;
      const { res, finalUrl } = hopResult;

      const contentType = res.headers.get("content-type") ?? "";
      const { text: raw, bytesRead, truncated } = await readResponseTextCapped(res, MAX_BYTES);
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
      return formatFetchError(err, url, ctrl, TIMEOUT_MS);
    } finally {
      clearTimeout(timeout);
    }
  },
  {
    name: "web_fetch",
    description:
      "Fetch the content of a URL. Default mode='text' returns extracted plain text (good for summarizing articles). " +
      "mode='html' returns raw HTML if you specifically need markup. Truncates after 200KB. " +
      "When the separate DeepSeek Search & Fetch integration is configured, public text-mode URLs are fetched through DeepSeek and returned as Markdown without image extraction. " +
      "HTML requests and hosts in Allowed sites keep using direct fetch, preserving browser-cookie authentication. " +
      "Use this when web_search returns a URL but you need the actual page content, or to fetch a specific known page. " +
      "The response also includes an `images` object with absolute URLs extracted from the page: " +
      "`og` (og:image — usually the best hero image), `twitter` (twitter:image), and `samples` (first few <img> tags). " +
      "Embed these in your reply with markdown `![alt](url)` to produce rich, image-rich answers.",
    schema: z.object({
      url: z.string().describe("Absolute URL starting with http:// or https://"),
      mode: z.enum(["text", "html"]).optional().describe("'text' (default) extracts readable text; 'html' returns raw markup using direct fetch"),
      max_chars: z.number().optional().describe("Max characters to return after extraction (default 8000)"),
    }),
  },
);

registerLangChainPackage({
  category: "Web",
  tools: { read: [webFetchTool] },
});
