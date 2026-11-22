import { describe, expect, it } from "vitest";
import { createStreamingSpeechSplitter } from "./stream";
import { cleanSpeechChunk, plainTextForTts } from "./text";

describe("createStreamingSpeechSplitter", () => {
  it("speaks each complete sentence as soon as it lands", () => {
    const splitter = createStreamingSpeechSplitter();
    expect(splitter.take("Sure, I can help")).toEqual([]);
    expect(splitter.take("Sure, I can help. The build")).toEqual(["Sure, I can help."]);
    expect(splitter.take("Sure, I can help. The build is green. Want")).toEqual(["The build is green."]);
  });

  it("never repeats a slice it already returned", () => {
    const splitter = createStreamingSpeechSplitter();
    expect(splitter.take("One. Two. ")).toEqual(["One.", "Two."]);
    expect(splitter.take("One. Two. Three. ")).toEqual(["Three."]);
    expect(splitter.take("One. Two. Three. ", { flush: true })).toEqual([]);
  });

  it("flushes the unfinished tail when the reply ends", () => {
    const splitter = createStreamingSpeechSplitter();
    expect(splitter.take("Still typing")).toEqual([]);
    expect(splitter.take("Still typing", { flush: true })).toEqual(["Still typing"]);
  });

  it("reads prose around a finished code fence", () => {
    const splitter = createStreamingSpeechSplitter();
    const buffer = "Here is the fix:\n```js\nrun(42)\n```\nThat should do it.";
    expect(splitter.take(buffer, { flush: true })).toEqual(["Here is the fix:", "That should do it."]);
  });

  it("holds an unterminated fence until it closes", () => {
    const splitter = createStreamingSpeechSplitter();
    expect(splitter.take("Look:\n```js\nconst a = 1;")).toEqual(["Look:"]);
    expect(splitter.take("Look:\n```js\nconst a = 1;\n```\nDone now.", { flush: true })).toEqual(["Done now."]);
  });

  it("skips table rows", () => {
    const splitter = createStreamingSpeechSplitter();
    const buffer = "| key | value |\n| --- | --- |\n| a | b |\nBoth columns agree.";
    expect(splitter.take(buffer, { flush: true })).toEqual(["Both columns agree."]);
  });

  it("splits prose with no terminator at a word gap", () => {
    const splitter = createStreamingSpeechSplitter({ maxChars: 40 });
    const [first] = splitter.take("word ".repeat(30), { flush: true });
    expect(first.length).toBeLessThanOrEqual(40);
    expect(first.endsWith("word")).toBe(true);
  });

  it("starts over after a reset", () => {
    const splitter = createStreamingSpeechSplitter();
    expect(splitter.take("First answer. ")).toEqual(["First answer."]);
    splitter.reset();
    expect(splitter.take("Second answer. ")).toEqual(["Second answer."]);
  });
});

describe("speech text projection", () => {
  it("strips markdown and code from a finished message", () => {
    expect(plainTextForTts("## Title\nUse `npm run lint` and see [docs](https://x.dev)."))
      .toBe("Title Use npm run lint and see docs.");
    expect(plainTextForTts([{ type: "text", text: "hello" }])).toBe("hello");
  });

  it("drops chunks that carry no words", () => {
    expect(cleanSpeechChunk("| a | b |")).toBe("");
    expect(cleanSpeechChunk("**Done**")).toBe("Done");
  });
});
