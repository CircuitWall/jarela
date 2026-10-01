import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HumanMessage } from "@langchain/core/messages";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-llm-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  isContextOverflowError,
  parseContextLimitFromError,
  isRateLimitError,
  parseRetryAfterSeconds,
  toBaseMessages,
} = await import("./llm");
const { spillImagePart, spillFileBuffer } = await import("@/lib/attachments/spill");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("toBaseMessages", () => {
  it("omits image blocks for text-only model calls", async () => {
    const messages = await toBaseMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", media_type: "image/png", data: "abcd" },
        ],
      },
    ], undefined, { includeImages: false });

    const human = messages[0] as HumanMessage;
    expect(JSON.stringify(human.content)).toContain("image attachment omitted");
    expect(JSON.stringify(human.content)).not.toContain("image_url");
  });

  it("re-reads an image_ref for the newest message but collapses an older occurrence to a placeholder (ADR-0090)", async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ref = await spillImagePart({ type: "image", media_type: "image/png", data: png.toString("base64") });

    const messages = await toBaseMessages([
      { role: "user", content: [{ type: "text", text: "here's a screenshot" }, ref] },
      { role: "assistant", content: "noted" },
      { role: "user", content: [{ type: "text", text: "look again" }, ref] },
    ]);

    const olderBlocks = (messages[0] as HumanMessage).content as Array<{ type: string; text?: string }>;
    expect(olderBlocks.some((b) => b.text?.includes(`view_attachment({name: "${ref.name}"`))).toBe(true);
    expect(olderBlocks.some((b) => b.type === "image_url")).toBe(false);

    const newestBlocks = (messages[2] as HumanMessage).content as Array<{ type: string; image_url?: { url: string } }>;
    const imageBlock = newestBlocks.find((b) => b.type === "image_url");
    expect(imageBlock?.image_url?.url).toContain(png.toString("base64"));
  });

  it("re-reads a text file_ref for the newest message but collapses an older occurrence to a placeholder", async () => {
    const ref = await spillFileBuffer(Buffer.from("console.log(1)"), "text/plain", "snippet.txt");

    const messages = await toBaseMessages([
      { role: "user", content: [{ type: "text", text: "here's a file" }, ref] },
      { role: "user", content: [{ type: "text", text: "re-check it" }, ref] },
    ]);

    const olderBlocks = (messages[0] as HumanMessage).content as Array<{ type: string; text?: string }>;
    expect(olderBlocks.some((b) => b.text?.includes(`view_attachment({name: "${ref.name}"`))).toBe(true);
    expect(olderBlocks.some((b) => b.text?.includes("console.log(1)"))).toBe(false);

    const newestBlocks = (messages[1] as HumanMessage).content as Array<{ type: string; text?: string }>;
    expect(newestBlocks.some((b) => b.text?.includes("console.log(1)"))).toBe(true);
  });

  it("never inlines a non-text file_ref's bytes, even for the newest message", async () => {
    const ref = await spillFileBuffer(Buffer.from("%PDF-fake"), "application/pdf", "report.pdf");

    const messages = await toBaseMessages([
      { role: "user", content: [{ type: "text", text: "a pdf" }, ref] },
    ]);

    const content = JSON.stringify((messages[0] as HumanMessage).content);
    expect(content).toContain("report.pdf");
    expect(content).not.toContain("%PDF-fake");
  });

  it("falls back to an 'unavailable' placeholder when the newest message's file_ref is missing on disk", async () => {
    const missingRef = {
      type: "file_ref" as const,
      media_type: "text/plain",
      name: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.txt",
      filename: "gone.txt",
    };

    const messages = await toBaseMessages([
      { role: "user", content: [{ type: "text", text: "read this" }, missingRef] },
    ]);

    expect(JSON.stringify((messages[0] as HumanMessage).content)).toContain("unavailable");
  });
});

describe("isContextOverflowError", () => {
  it("matches OpenAI phrasing", () => {
    expect(isContextOverflowError("This model's maximum context length is 128000 tokens. However, your messages resulted in 213998 tokens")).toBe(true);
  });
  it("matches Anthropic phrasing", () => {
    expect(isContextOverflowError("prompt is too long: 235812 tokens > 200000 maximum")).toBe(true);
  });
  it("matches Gemini phrasing", () => {
    expect(isContextOverflowError("The input token count (1234567) exceeds the maximum number of tokens allowed (1048576).")).toBe(true);
  });
  it("ignores unrelated errors", () => {
    expect(isContextOverflowError("fetch failed: ECONNREFUSED")).toBe(false);
    expect(isContextOverflowError("")).toBe(false);
  });
});

describe("parseContextLimitFromError", () => {
  it("parses OpenAI limit + requested", () => {
    expect(
      parseContextLimitFromError("This model's maximum context length is 128000 tokens. However, your messages resulted in 213998 tokens"),
    ).toEqual({ limit: 128000, requested: 213998 });
  });
  it("parses OpenAI 'requested' phrasing", () => {
    expect(
      parseContextLimitFromError("This model's maximum context length is 8192 tokens, however you requested 9000 tokens"),
    ).toEqual({ limit: 8192, requested: 9000 });
  });
  it("parses Anthropic phrasing", () => {
    expect(
      parseContextLimitFromError("prompt is too long: 235812 tokens > 200000 maximum"),
    ).toEqual({ limit: 200000, requested: 235812 });
  });
  it("parses Gemini phrasing", () => {
    expect(
      parseContextLimitFromError("The input token count (1234567) exceeds the maximum number of tokens allowed (1048576)."),
    ).toEqual({ limit: 1048576, requested: 1234567 });
  });
  it("parses DeepSeek range phrasing", () => {
    expect(
      parseContextLimitFromError("Range of input length should be [1, 65536]"),
    ).toEqual({ limit: 65536 });
  });
  it("strips comma grouping", () => {
    expect(
      parseContextLimitFromError("This model's maximum context length is 1,047,576 tokens"),
    ).toEqual({ limit: 1047576 });
  });
  it("returns null when no number pair is present", () => {
    expect(parseContextLimitFromError("context window exhausted, retry later")).toBeNull();
    expect(parseContextLimitFromError("")).toBeNull();
  });
});

describe("isRateLimitError", () => {
  it("matches SDK APIError with status=429", () => {
    expect(isRateLimitError({ status: 429 }, "429 status code (no body)")).toBe(true);
  });
  it("matches by message when status is missing (Anthropic bare message)", () => {
    expect(isRateLimitError(new Error("429 status code (no body)"), "429 status code (no body)")).toBe(true);
  });
  it("matches common phrasings", () => {
    expect(isRateLimitError(null, "rate_limit_exceeded: quota exhausted")).toBe(true);
    expect(isRateLimitError(null, "Too Many Requests")).toBe(true);
    expect(isRateLimitError(null, "OpenAI: quota exceeded on requests-per-minute")).toBe(true);
  });
  it("ignores unrelated errors", () => {
    expect(isRateLimitError(null, "ECONNREFUSED")).toBe(false);
    expect(isRateLimitError(null, "context_length_exceeded")).toBe(false);
    expect(isRateLimitError(null, "")).toBe(false);
  });
});

describe("parseRetryAfterSeconds", () => {
  it("reads lowercase retry-after header (string)", () => {
    expect(parseRetryAfterSeconds({ headers: { "retry-after": "30" } }, "429")).toBe(30);
  });
  it("reads title-case Retry-After header (number)", () => {
    expect(parseRetryAfterSeconds({ headers: { "Retry-After": 12 } }, "429")).toBe(12);
  });
  it("falls back to message-body regex", () => {
    expect(parseRetryAfterSeconds(null, "please retry after 45 seconds")).toBe(45);
  });
  it("rounds fractional seconds up", () => {
    expect(parseRetryAfterSeconds({ headers: { "retry-after": "1.4" } }, "")).toBe(2);
  });
  it("returns null when no hint present", () => {
    expect(parseRetryAfterSeconds({}, "429 status code (no body)")).toBeNull();
    expect(parseRetryAfterSeconds(null, "")).toBeNull();
  });
});
