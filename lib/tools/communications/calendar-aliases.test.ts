import { afterEach, describe, expect, it, vi } from "vitest";
import { outlookCalendarCreateEventTool, outlookCalendarUpdateEventTool } from "@/lib/tools/communications/outlook-calendar";
import { calendarCreateEventTool, calendarUpdateEventTool } from "@/lib/tools/communications/calendar";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

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

  it("rejects impossible RFC3339 calendar dates and offsets", () => {
    const schema = outlookCalendarCreateEventTool.schema!;
    expect(() => schema.parse({
      subject: "Invalid date",
      start_iso: "2026-02-31T10:00:00Z",
      end_iso: "2026-03-01T11:00:00Z",
    })).toThrow();
    expect(() => schema.parse({
      subject: "Invalid offset",
      start_iso: "2026-01-01T10:00:00+24:00",
      end_iso: "2026-01-01T11:00:00Z",
    })).toThrow();
  });

  it("converts RFC3339 instants to offset-free Graph times in the requested IANA zone", async () => {
    vi.stubEnv("OUTLOOK_CLIENT_ID", "test-client");
    vi.stubEnv("OUTLOOK_CLIENT_SECRET", "test-secret");
    vi.stubEnv("OUTLOOK_REFRESH_TOKEN", "outlook-calendar-timezone-contract");
    const calls: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth2/")) {
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
      }
      calls.push({ url, body: init?.body as string | undefined });
      return new Response(JSON.stringify({ id: "event-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }));

    await outlookCalendarCreateEventTool.invoke({
      subject: "Appointment",
      start_iso: "2026-01-01T18:00:00.000001Z",
      end_iso: "2026-01-01T19:30:00.123456Z",
      time_zone: "America/Los_Angeles",
    });

    const body = JSON.parse(calls[0].body ?? "{}");
    expect(body.start).toEqual({ dateTime: "2026-01-01T10:00:00.000001", timeZone: "America/Los_Angeles" });
    expect(body.end).toEqual({ dateTime: "2026-01-01T11:30:00.123456", timeZone: "America/Los_Angeles" });
  });

  it("maps Windows timezone names for conversion and preserves them for Graph", async () => {
    vi.stubEnv("OUTLOOK_CLIENT_ID", "test-client");
    vi.stubEnv("OUTLOOK_CLIENT_SECRET", "test-secret");
    vi.stubEnv("OUTLOOK_REFRESH_TOKEN", "outlook-calendar-windows-timezone");
    const calls: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth2/")) {
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
      }
      calls.push({ url, body: init?.body as string | undefined });
      return new Response(JSON.stringify({ id: "event-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }));

    await outlookCalendarCreateEventTool.invoke({
      subject: "Appointment",
      start_iso: "2026-01-01T18:00:00Z",
      end_iso: "2026-01-01T19:00:00Z",
      time_zone: "Pacific Standard Time",
    });
    const body = JSON.parse(calls[0].body ?? "{}");
    expect(body.start).toEqual({ dateTime: "2026-01-01T10:00:00", timeZone: "Pacific Standard Time" });
    expect(body.end).toEqual({ dateTime: "2026-01-01T11:00:00", timeZone: "Pacific Standard Time" });
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
