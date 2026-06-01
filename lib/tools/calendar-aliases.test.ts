import { describe, expect, it } from "vitest";
import { outlookCalendarCreateEventTool, outlookCalendarUpdateEventTool } from "@/lib/tools/outlook-calendar";
import { calendarCreateEventTool, calendarUpdateEventTool } from "@/lib/tools/calendar";

// The Outlook tools take `subject`; the Google tools take `summary`.
// Agents routinely mix the two — accept each platform's foreign name as an
// alias so the first tool call doesn't fail schema validation.

describe("calendar event title aliasing", () => {
  it("outlook create accepts `summary` alias", () => {
    const schema = outlookCalendarCreateEventTool.schema!;
    const parsed = schema.parse({
      summary: "Hello",
      start_iso: "2026-01-01T10:00:00Z",
      end_iso: "2026-01-01T11:00:00Z",
    });
    expect(parsed.summary).toBe("Hello");
  });

  it("outlook update accepts `summary` alias", () => {
    const schema = outlookCalendarUpdateEventTool.schema!;
    const parsed = schema.parse({ event_id: "abc", summary: "Renamed" });
    expect(parsed.summary).toBe("Renamed");
  });

  it("outlook create still accepts native `subject`", () => {
    const schema = outlookCalendarCreateEventTool.schema!;
    const parsed = schema.parse({
      subject: "Native",
      start_iso: "2026-01-01T10:00:00Z",
      end_iso: "2026-01-01T11:00:00Z",
    });
    expect(parsed.subject).toBe("Native");
  });

  it("google create accepts `subject` alias", () => {
    const schema = calendarCreateEventTool.schema!;
    const parsed = schema.parse({
      subject: "Hello",
      start_iso: "2026-01-01T10:00:00Z",
      end_iso: "2026-01-01T11:00:00Z",
    });
    expect(parsed.subject).toBe("Hello");
  });

  it("google update accepts `subject` alias", () => {
    const schema = calendarUpdateEventTool.schema!;
    const parsed = schema.parse({ event_id: "abc", subject: "Renamed" });
    expect(parsed.subject).toBe("Renamed");
  });

  it("google create still accepts native `summary`", () => {
    const schema = calendarCreateEventTool.schema!;
    const parsed = schema.parse({
      summary: "Native",
      start_iso: "2026-01-01T10:00:00Z",
      end_iso: "2026-01-01T11:00:00Z",
    });
    expect(parsed.summary).toBe("Native");
  });
});
