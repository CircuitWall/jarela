import { describe, it, expect, vi } from "vitest";
import { summarizeTranscript, summarizeTranscriptWithRetry, SummaryTimeoutError, transcriptText } from "./conversation-summary";
import type { ModelProvider, ProviderMessage, ProviderParams } from "@/lib/providers/types";

describe("transcriptText", () => {
  it("returns plain text unchanged", () => {
    expect(transcriptText("hello")).toBe("hello");
  });

  it("flattens content parts and stubs attachments", () => {
    const raw = JSON.stringify([
      { type: "text", text: "hello" },
      { type: "image", media_type: "image/png", data: "a" },
      { type: "file", name: "report.pdf", media_type: "application/pdf", data: "b" },
    ]);
    expect(transcriptText(raw)).toContain("hello");
    expect(transcriptText(raw)).toContain("[image attachment: image/png]");
    expect(transcriptText(raw)).toContain("[file attachment: report.pdf (application/pdf)]");
  });

  it("falls back to raw when JSON is malformed", () => {
    expect(transcriptText("[not-json")).toBe("[not-json");
  });
});

describe("summarizeTranscript", () => {
  it("returns empty for empty transcript", async () => {
    const provider = {
      chat: vi.fn(),
    } as unknown as Pick<ModelProvider, "chat">;
    const out = await summarizeTranscript(provider, "m", {}, "   ");
    expect(out).toBe("");
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("streams chunks and trims final summary", async () => {
    const chat = vi.fn(async (_modelId: string, _messages: ProviderMessage[], _params: ProviderParams) => {
      async function* gen() {
        yield "  first";
        yield " second  ";
      }
      return { stream: gen() };
    });

    const provider = { chat } as unknown as Pick<ModelProvider, "chat">;
    const out = await summarizeTranscript(provider, "model-x", { max_tokens: 100 }, "conversation");
    expect(out).toBe("first second");
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("sends summarizer system prompt and transcript payload", async () => {
    const chat = vi.fn(async (_modelId: string, messages: ProviderMessage[], _params: ProviderParams) => {
      expect(messages[0].role).toBe("system");
      expect(String(messages[0].content)).toContain("concise summarizer");
      expect(messages[1].role).toBe("user");
      expect(String(messages[1].content)).toContain("Conversation to summarize");
      expect(String(messages[1].content)).toContain("alpha beta");
      async function* gen() {
        yield "ok";
      }
      return { stream: gen() };
    });

    const provider = { chat } as unknown as Pick<ModelProvider, "chat">;
    const out = await summarizeTranscript(provider, "model-x", {}, "alpha beta");
    expect(out).toBe("ok");
  });

  it("times out and rejects with SummaryTimeoutError when the stream hangs", async () => {
    const chat = vi.fn(async () => {
      // A stream that never yields and never closes — models the observed
      // GitHub-Copilot hang where the HTTP stream opens but no chunks arrive.
      async function* gen() {
        await new Promise(() => {});
        yield "unreachable";
      }
      return { stream: gen() };
    });
    const provider = { chat } as unknown as Pick<ModelProvider, "chat">;
    await expect(
      summarizeTranscript(provider, "m", {}, "transcript", { timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(SummaryTimeoutError);
  });
});

describe("summarizeTranscriptWithRetry", () => {
  it("returns the first attempt's value when the call succeeds", async () => {
    const chat = vi.fn(async () => {
      async function* gen() {
        yield "first-try";
      }
      return { stream: gen() };
    });
    const provider = { chat } as unknown as Pick<ModelProvider, "chat">;
    const out = await summarizeTranscriptWithRetry(provider, "m", {}, "transcript");
    expect(out.text).toBe("first-try");
    expect(out.attempts).toBe(1);
    expect(out.lastError).toBeUndefined();
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("retries once on transient failure and succeeds on attempt 2", async () => {
    let calls = 0;
    const chat = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNRESET");
      async function* gen() {
        yield "after-retry";
      }
      return { stream: gen() };
    });
    const provider = { chat } as unknown as Pick<ModelProvider, "chat">;
    const out = await summarizeTranscriptWithRetry(provider, "m", {}, "transcript", { delayMs: 0 });
    expect(out.text).toBe("after-retry");
    expect(out.attempts).toBe(2);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("returns empty text + lastError when every attempt fails", async () => {
    const chat = vi.fn(async () => { throw new Error("boom"); });
    const provider = { chat } as unknown as Pick<ModelProvider, "chat">;
    const out = await summarizeTranscriptWithRetry(provider, "m", {}, "transcript", { delayMs: 0, attempts: 2 });
    expect(out.text).toBe("");
    expect(out.attempts).toBe(2);
    expect(out.lastError).toBeInstanceOf(Error);
    expect((out.lastError as Error).message).toBe("boom");
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("respects attempts override (single attempt = no retry)", async () => {
    const chat = vi.fn(async () => { throw new Error("boom"); });
    const provider = { chat } as unknown as Pick<ModelProvider, "chat">;
    const out = await summarizeTranscriptWithRetry(provider, "m", {}, "transcript", { attempts: 1 });
    expect(out.attempts).toBe(1);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("clamps attempts to a minimum of 1", async () => {
    const chat = vi.fn(async () => {
      async function* gen() { yield "ok"; }
      return { stream: gen() };
    });
    const provider = { chat } as unknown as Pick<ModelProvider, "chat">;
    const out = await summarizeTranscriptWithRetry(provider, "m", {}, "transcript", { attempts: 0 });
    expect(out.attempts).toBe(1);
  });

  it("forwards timeoutMs to each summarizeTranscript attempt and exhausts retries on hang", async () => {
    const chat = vi.fn(async () => {
      async function* gen() {
        await new Promise(() => {});
        yield "unreachable";
      }
      return { stream: gen() };
    });
    const provider = { chat } as unknown as Pick<ModelProvider, "chat">;
    const out = await summarizeTranscriptWithRetry(provider, "m", {}, "transcript", {
      attempts: 2,
      delayMs: 0,
      timeoutMs: 20,
    });
    expect(out.text).toBe("");
    expect(out.attempts).toBe(2);
    expect(out.lastError).toBeInstanceOf(SummaryTimeoutError);
    expect(chat).toHaveBeenCalledTimes(2);
  });
});
