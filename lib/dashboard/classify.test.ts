import { describe, expect, it } from "vitest";
import { detectModelFunctionality } from "./classify";

describe("detectModelFunctionality", () => {
  const cases: Array<[string, ReturnType<typeof detectModelFunctionality>]> = [
    ["text-embedding-3-large", "embeddings"],
    ["voyage-large-2", "embeddings"],
    ["rerank-3", "reranking"],
    ["omni-moderation-latest", "moderation"],
    ["gpt-4-vision-preview", "multimodal"],
    ["qwen2-vl-7b", "multimodal"],
    ["whisper-1", "audio"],
    ["tts-1-hd", "audio"],
    ["deepseek-coder-v2", "coding"],
    ["o1-mini", "reasoning"],
    ["o3-pro", "reasoning"],
    ["deepseek-r1", "reasoning"],
    ["gpt-4o", "chat"],
    ["claude-3-5-sonnet", "chat"],
    ["gemini-1.5-pro", "chat"],
    ["llama-3.1-70b-instruct", "chat"],
    ["mistral-large", "chat"],
    ["entirely-novel-model", "other"],
    ["", "other"],
  ];

  for (const [id, expected] of cases) {
    it(`classifies "${id}" as ${expected}`, () => {
      expect(detectModelFunctionality(id)).toBe(expected);
    });
  }

  it("is case-insensitive", () => {
    expect(detectModelFunctionality("WHISPER-LARGE")).toBe("audio");
  });

  it("tolerates null-ish input via defensive coercion", () => {
    // @ts-expect-error testing runtime guard
    expect(detectModelFunctionality(undefined)).toBe("other");
  });
});
