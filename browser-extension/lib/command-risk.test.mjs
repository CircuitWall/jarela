import { describe, expect, it } from "vitest";
import { classifyCommandRisk } from "./command-risk.mjs";

describe("classifyCommandRisk", () => {
  it("treats ordinary clicks as normal", () => {
    expect(classifyCommandRisk({ type: "click", selector: "button.save" }, { host: "example.com" })).toEqual({
      level: "normal",
      reasons: [],
    });
  });

  it("flags whole-page extracts", () => {
    const risk = classifyCommandRisk({ type: "extract", format: "text" }, { host: "example.com" });
    expect(risk.level).toBe("sensitive");
    expect(risk.reasons).toContain("reads the whole page");
  });

  it("flags screenshots", () => {
    const risk = classifyCommandRisk({ type: "screenshot" }, { host: "example.com" });
    expect(risk.reasons).toContain("captures visible page pixels");
  });

  it("flags auth and payment hosts", () => {
    const risk = classifyCommandRisk({ type: "click", selector: "button" }, { host: "accounts.example.com" });
    expect(risk.reasons).toContain("sensitive site");
  });

  it("flags sensitive batch fill fields without returning values", () => {
    const risk = classifyCommandRisk({
      type: "fill_many",
      fields: [
        { selector: "input[name=email]", value: "user@example.com" },
        { selector: "input[type=password]", value: "not-returned" },
      ],
    }, { host: "example.com" });
    expect(risk.level).toBe("sensitive");
    expect(risk.reasons).toContain("sensitive field in batch fill");
    expect(JSON.stringify(risk)).not.toContain("not-returned");
  });
});