import { describe, expect, it } from "vitest";
import { validatePersonalBriefing, validatePersonalBriefingTool } from "./validate-personal-briefing";
import { registeredCapability } from "../runtime/registry";

const valid = () => ({
  sources: [{ id: "calendar:one", available: true }, { id: "mail", available: false }],
  briefing: {
    items: [{ text: "Review the calendar item.", source_ids: ["calendar:one"] }],
    unavailable_source_ids: ["mail"],
  },
});

describe("personal briefing contract", () => {
  it("accepts referenced items with explicit source gaps without claiming factual verification", async () => {
    expect(registeredCapability("validate_personal_briefing")).toBe("read");
    const result = JSON.parse(String(await validatePersonalBriefingTool.invoke(valid())));
    expect(result.ok).toBe(true);
    expect(result.briefing).toEqual(valid().briefing);
    expect(result.limitation).toContain("do not verify retrieval provenance");
  });

  it.each([
    null,
    { ...valid(), sources: [] },
    { ...valid(), sources: [...valid().sources, valid().sources[0]] },
    { ...valid(), briefing: { ...valid().briefing, unavailable_source_ids: [] } },
    { ...valid(), briefing: { ...valid().briefing, unavailable_source_ids: ["calendar:one"] } },
    { ...valid(), briefing: { ...valid().briefing, unavailable_source_ids: ["mail", "mail"] } },
    { ...valid(), briefing: { ...valid().briefing, items: [{ text: "Unsupported", source_ids: ["missing"] }] } },
    { ...valid(), briefing: { ...valid().briefing, items: [{ text: "Unavailable", source_ids: ["mail"] }] } },
    { ...valid(), briefing: { ...valid().briefing, items: [{ text: "Duplicate", source_ids: ["calendar:one", "calendar:one"] }] } },
    { ...valid(), briefing: { ...valid().briefing, items: [{ text: "   ", source_ids: [] }] } },
  ])("rejects invalid drafts with actionable field issues", (input) => {
    expect(validatePersonalBriefing(input)).toMatchObject({ ok: false, issues: expect.any(Array) });
  });
});
