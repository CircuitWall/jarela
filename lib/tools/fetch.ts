import { tool } from "@langchain/core/tools";
import { z } from "zod";

const MAX_BYTES = 200_000;
const TIMEOUT_MS = 15_000;

// Strip script/style blocks and tags, collapse whitespace. Cheap text-only
// extraction — enough for the agent to summarize a page without needing a
// full HTML parser.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

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
      return JSON.stringify({ error: "url must start with http:// or https://" });
    }
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      const contentType = res.headers.get("content-type") ?? "";
      const finalUrl = res.url;
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
      const body = wantHtml ? raw : htmlToText(raw);
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
      return JSON.stringify({ url, error: msg });
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
