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

      return JSON.stringify({
        url: finalUrl,
        status: res.status,
        content_type: contentType,
        title,
        mode: wantHtml ? "html" : "text",
        bytes_read: bytesRead,
        truncated,
        content: clipped,
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
      "Use this when web_search returns a URL but you need the actual page content, or to fetch a specific known page.",
    schema: z.object({
      url: z.string().describe("Absolute URL starting with http:// or https://"),
      mode: z.enum(["text", "html"]).optional().describe("'text' (default) extracts readable text; 'html' returns raw markup"),
      max_chars: z.number().optional().describe("Max characters to return after extraction (default 8000)"),
    }),
  },
);
