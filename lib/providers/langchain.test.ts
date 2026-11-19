import { describe, expect, it } from "vitest";
import { langchainProvider, toLangChainTextContent } from "./langchain";

describe("langchain provider content handling", () => {
  // Issue #935: ChatCohere rejects non-string message content, and the bridge
  // used to replace multimodal content with "" on the agent path — the model
  // then answered an empty question with no indication the attachment was
  // dropped.
  it("joins text parts and rejects image parts with the model named", () => {
    expect(toLangChainTextContent(
      [{ type: "text", text: "Describe" }, { type: "text", text: "this" }],
      "user",
      "ChatCohere",
    )).toBe("Describe\nthis");

    expect(() => toLangChainTextContent(
      [
        { type: "text", text: "What is this?" },
        { type: "image", media_type: "image/png", data: "AA==" },
        { type: "image_ref", media_type: "image/png", name: "shot.png" },
      ],
      "user",
      "ChatCohere",
    )).toThrow(/ChatCohere accepts text only.*\[image, image_ref\] content.*vision-capable provider/s);
  });

  it("fails before any provider work when a turn carries an image", async () => {
    // No credentials or network: the rejection must not depend on them.
    await expect(langchainProvider.invoke(
      "command-a-vision-07-2025",
      [{ role: "user", content: [{ type: "image", media_type: "image/png", data: "AA==" }] }],
      { lc_class: "ChatCohere" },
      [],
    )).rejects.toThrow(/Nothing was sent to the provider/);
  });
});
