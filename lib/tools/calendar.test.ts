import { describe, expect, it } from "vitest";

const { calendarListEventsTool } = await import("./calendar");

describe("calendar_list_events", () => {
  it("rejects date-only time bounds before calling Google Calendar", async () => {
    await expect(calendarListEventsTool.invoke({ time_min: "2026-05-19" }))
      .rejects.toThrow(/RFC3339 datetime/);
  });
});