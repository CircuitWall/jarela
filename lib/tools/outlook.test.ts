import { describe, expect, it } from "vitest";

const { outlookCreateDraftTool } = await import("./outlook");

describe("outlook_create_draft", () => {
  it("rejects oversized draft bodies before calling Microsoft Graph", async () => {
    await expect(outlookCreateDraftTool.invoke({
      to: ["user@example.test"],
      subject: "Oversized",
      body: "x".repeat(100_001),
    })).rejects.toThrow(/100000/);
  });
});