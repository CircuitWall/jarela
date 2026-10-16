import { afterEach, describe, expect, it, vi } from "vitest";

const { calendarGetEventTool, calendarListEventsTool } = await import("./calendar");
const { outlookCalendarGetEventTool } = await import("./outlook-calendar");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function stubApi(tokenHost: string, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes(tokenHost)) return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

describe("calendar source links", () => {
  it("returns Google's htmlLink as html_link and cite_as", async () => {
    vi.stubEnv("GMAIL_CLIENT_ID", "test-client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "test-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "calendar-source-link-refresh");
    const htmlLink = "https://www.google.com/calendar/event?eid=ZXZ0MSB1c2VyQGV4YW1wbGUudGVzdA";
    stubApi("oauth2", { id: "evt1", summary: "Dentist", htmlLink });

    const out = JSON.parse(await calendarGetEventTool.invoke({ event_id: "evt1" })) as Record<string, unknown>;

    expect(out.html_link).toBe(htmlLink);
    expect(out.cite_as).toBe(`[Dentist](${htmlLink})`);
  });

  it("returns Outlook's webLink as web_link and cite_as", async () => {
    vi.stubEnv("OUTLOOK_CLIENT_ID", "test-client");
    vi.stubEnv("OUTLOOK_CLIENT_SECRET", "test-secret");
    vi.stubEnv("OUTLOOK_REFRESH_TOKEN", "outlook-calendar-source-link-refresh");
    const webLink = "https://outlook.office365.com/owa/?itemid=AAMk%3D&exvsurl=1&path=/calendar/item";
    stubApi("/oauth2/", { id: "evt2", subject: "Standup", webLink });

    const out = JSON.parse(await outlookCalendarGetEventTool.invoke({ event_id: "evt2" })) as Record<string, unknown>;

    expect(out.web_link).toBe(webLink);
    expect(out.cite_as).toBe(`[Standup](${webLink})`);
  });
});

describe("calendar_list_events", () => {
  it("rejects date-only time bounds before calling Google Calendar", async () => {
    await expect(calendarListEventsTool.invoke({ time_min: "2026-05-19" }))
      .rejects.toThrow(/RFC3339 datetime/);
  });
});