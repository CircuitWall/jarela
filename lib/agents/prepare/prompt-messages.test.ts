import { describe, expect, it } from "vitest";
import { assemblePromptMessages, EmptyPromptError, promptTurnText, type PromptTurn } from "./prompt-messages";

const user = (content: string): PromptTurn => ({ role: "user", content });
const assistant = (content: string): PromptTurn => ({ role: "assistant", content });

describe("assemblePromptMessages", () => {
  it("leaves a window that already ends with the current turn alone", () => {
    const history = [user("first"), assistant("answer"), user("current question")];
    const result = assemblePromptMessages({ hotHistory: history, includeHot: true, currentContent: "current question" });
    expect(result.currentTurnSource).toBe("history");
    expect(result.recoveredFromEmptyWindow).toBe(false);
    expect(result.messages).toEqual(history);
  });

  it("injects the request when a requested window does not carry it", () => {
    // The production failure: the persisted row is filtered out of the window
    // (in-progress / pruned / budget-clipped) and nothing else adds it.
    const history = [user("older"), assistant("older answer")];
    const result = assemblePromptMessages({ hotHistory: history, includeHot: true, currentContent: "try again" });
    expect(result.currentTurnSource).toBe("injected");
    expect(result.recoveredFromEmptyWindow).toBe(true);
    expect(result.messages.at(-1)).toEqual(user("try again"));
  });

  it("keeps the request when the profile asks for no history", () => {
    const result = assemblePromptMessages({
      hotHistory: [user("older"), assistant("older answer")],
      includeHot: false,
      currentContent: "one-shot request",
    });
    expect(result.currentTurnSource).toBe("profile");
    expect(result.messages).toEqual([user("one-shot request")]);
  });

  it("appends a retry nudge after the current turn instead of replacing it", () => {
    const result = assemblePromptMessages({
      hotHistory: [],
      includeHot: false,
      currentContent: "the original request",
      extraUserContext: "↻ Auto-retry: continue where you stopped.",
    });
    expect(result.messages).toEqual([
      user("the original request"),
      user("↻ Auto-retry: continue where you stopped."),
    ]);
  });

  it("rejects a turn with no user text instead of calling the model", () => {
    expect(() => assemblePromptMessages({ hotHistory: [], includeHot: true, currentContent: "" }))
      .toThrow(EmptyPromptError);
    expect(() => assemblePromptMessages({ hotHistory: [assistant("only an answer")], includeHot: true, currentContent: "   " }))
      .toThrow(EmptyPromptError);
    expect(() => assemblePromptMessages({ hotHistory: [], includeHot: false, currentContent: "" }))
      .toThrow(/no user content/i);
  });

  it("counts only text parts, so an image-only turn is rejected", () => {
    expect(promptTurnText([{ type: "image_ref", media_type: "image/png", name: "a.png", sha256: "x", size: 1 }])).toBe("");
    expect(() => assemblePromptMessages({
      hotHistory: [],
      includeHot: false,
      currentContent: [{ type: "image_ref", media_type: "image/png", name: "a.png", sha256: "x", size: 1 }],
    })).toThrow(EmptyPromptError);
  });

  it("keeps text that accompanies an attachment", () => {
    const result = assemblePromptMessages({
      hotHistory: [],
      includeHot: false,
      currentContent: [
        { type: "text", text: "summarise this" },
        { type: "image_ref", media_type: "image/png", name: "a.png", sha256: "x", size: 1 },
      ],
    });
    expect(result.messages).toHaveLength(1);
    expect(promptTurnText(result.messages[0].content)).toBe("summarise this");
  });
});
