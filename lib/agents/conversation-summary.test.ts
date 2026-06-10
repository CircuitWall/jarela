import { describe, it, expect, vi } from "vitest";
import { summarizeTranscript, transcriptText } from "./conversation-summary";
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
      expect(String(messages[0].content)).toContain("compressing a chat transcript");
      expect(String(messages[0].content)).toContain("Artefacts (verbatim)");
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
});
