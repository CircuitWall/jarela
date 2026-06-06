import { describe, it, expect } from "vitest";
import { composePrompt, parseExtensionTurn } from "./extension-turn-prompt";

describe("composePrompt / parseExtensionTurn", () => {
  it("roundtrips a refine turn with all fields", () => {
    const prompt = composePrompt("refine", {
      instruction: "Make this clearer.",
      text: "Some selected sentence.",
      url: "https://example.com/post",
      title: "Example Post",
      selector: "main > article > p:nth-of-type(2)",
      page_context: "Heading: Example\nIntro paragraph.",
    });
    const ctx = parseExtensionTurn(prompt);
    expect(ctx).not.toBeNull();
    expect(ctx).toMatchObject({
      action: "refine",
      actionLabel: "Refine selection",
      instruction: "Make this clearer.",
      url: "https://example.com/post",
      title: "Example Post",
      selector: "main > article > p:nth-of-type(2)",
      pageContext: "Heading: Example\nIntro paragraph.",
      selectedText: "Some selected sentence.",
    });
  });

  it("roundtrips a fill turn with no selected text", () => {
    const prompt = composePrompt("fill", {
      instruction: "Compose a reply.",
      url: "https://mail.example/inbox/42",
      title: "Inbox · 42",
    });
    const ctx = parseExtensionTurn(prompt);
    expect(ctx).not.toBeNull();
    expect(ctx?.action).toBe("fill");
    expect(ctx?.actionLabel).toBe("Fill focused field");
    expect(ctx?.instruction).toBe("Compose a reply.");
    expect(ctx?.url).toBe("https://mail.example/inbox/42");
    expect(ctx?.title).toBe("Inbox · 42");
    expect(ctx?.selector).toBeNull();
    expect(ctx?.pageContext).toBeNull();
    expect(ctx?.selectedText).toBeNull();
  });

  it("roundtrips a rewrite_clipboard turn", () => {
    const prompt = composePrompt("rewrite_clipboard", {
      instruction: "Rewrite the selected text to be concise while preserving meaning.",
      text: "A rather long-winded version of the sentence.",
    });
    const ctx = parseExtensionTurn(prompt);
    expect(ctx?.action).toBe("rewrite_clipboard");
    expect(ctx?.actionLabel).toBe("Rewrite to clipboard");
    expect(ctx?.selectedText).toBe("A rather long-winded version of the sentence.");
  });

  it("treats whitespace-only selected text as none", () => {
    const prompt = composePrompt("refine", {
      instruction: "Tidy.",
      text: "   \n  ",
    });
    expect(parseExtensionTurn(prompt)?.selectedText).toBeNull();
  });

  it("returns null for non-extension prompts", () => {
    expect(parseExtensionTurn("Hello world")).toBeNull();
    expect(parseExtensionTurn("[Bridge reply] something")).toBeNull();
    expect(parseExtensionTurn("📎 Captured from https://example.com")).toBeNull();
  });

  it("preserves multi-line page context with blank lines inside selected text", () => {
    const prompt = composePrompt("refine", {
      instruction: "Edit.",
      page_context: "Line one\n\nLine three",
      text: "Selected line one\n\nSelected line two",
    });
    const ctx = parseExtensionTurn(prompt);
    expect(ctx?.pageContext).toBe("Line one\n\nLine three");
    expect(ctx?.selectedText).toBe("Selected line one\n\nSelected line two");
  });
});
