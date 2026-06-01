/**
 * Native Google Calendar tools — direct REST calls to
 * calendar.googleapis.com, sharing the Gmail OAuth client (one Google
 * account, one refresh token, one access-token cache; see
 * lib/integrations/gmail-oauth.ts).
 *
 * Scope-wise this surface is **events on existing calendars**:
 *   - list / get / create / update / delete events
 *   - list the user's calendars (read-only)
 * There is deliberately no calendar-list create/delete and no ACL
 * editing. To enable a wider surface, add the broader scope to
 * GMAIL_SCOPES and (force users to) reconnect.
 *
 * v1 design notes:
 *   - calendarId defaults to "primary" everywhere so the agent can
 *     create a quick event without first calling list_calendars.
 *   - All datetimes are RFC3339 strings (e.g. "2026-05-19T16:00:00-07:00").
 *     When the caller omits a timezone offset, Google falls back to the
 *     calendar's default TZ. The tools surface a `time_zone` field that
 *     forwards an IANA name in case the caller wants to be explicit.
 *   - `calendar_create_event` can provision a Google Meet link via the
 *     conferenceData createRequest dance — gated behind `add_meet_link`
 *     so unused calls don't trip Google's quota.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerTools } from "./registry";
import {
  googleFetch,
  resolveGoogleAuth,
  type GoogleAuth,
} from "@/lib/integrations/gmail-oauth";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const calendarFetch = (auth: GoogleAuth, path: string, init?: RequestInit) =>
  googleFetch(auth, "Calendar", CALENDAR_BASE, path, init);

// ── Type shapes (minimal — only what we read back) ──────────────────────────

interface CalendarListEntry {
  id?: string;
  summary?: string;
  primary?: boolean;
  timeZone?: string;
  accessRole?: string;
}

interface EventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface EventAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
}

interface CalendarEvent {
  id?: string;
  status?: string;
  htmlLink?: string;
  hangoutLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  attendees?: EventAttendee[];
}

// Slim down a full event to the fields the agent actually needs in a
// thread response. Keeps tool outputs small enough not to blow context.
function slimEvent(e: CalendarEvent): Record<string, unknown> {
  return {
    id: e.id,
    status: e.status,
    summary: e.summary ?? null,
    description: e.description ?? null,
    location: e.location ?? null,
    start: e.start?.dateTime ?? e.start?.date ?? null,
    end: e.end?.dateTime ?? e.end?.date ?? null,
    time_zone: e.start?.timeZone ?? e.end?.timeZone ?? null,
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.email,
      name: a.displayName ?? null,
      response: a.responseStatus ?? null,
    })),
    meet_link: e.hangoutLink ?? null,
    html_link: e.htmlLink ?? null,
  };
}

// ── Tools ───────────────────────────────────────────────────────────────────

export const calendarListCalendarsTool = tool(
  async () => {
    const auth = resolveGoogleAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await calendarFetch(auth, "/users/me/calendarList") as {
      items?: CalendarListEntry[];
      error?: string;
    };
    if ("error" in data && data.error) return JSON.stringify(data);
    return JSON.stringify({
      calendars: (data.items ?? []).map((c) => ({
        id: c.id,
        summary: c.summary ?? null,
        primary: c.primary === true,
        time_zone: c.timeZone ?? null,
        access_role: c.accessRole ?? null,
      })),
    });
  },
  {
    name: "calendar_list_calendars",
    description:
      "List the user's Google calendars (primary + any they've subscribed to). " +
      "Returns id, summary, primary flag, time zone, access role per entry. The " +
      "`id` is what other calendar_* tools expect as `calendar_id`. Use this when " +
      "the user mentions a non-primary calendar by name (e.g. 'put it on my Work " +
      "calendar') — match against `summary` to find the right id.",
    schema: z.object({}),
  },
);

export const calendarListEventsTool = tool(
  async ({ calendar_id, time_min, time_max, query, max_results }) => {
    const auth = resolveGoogleAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const cal = encodeURIComponent(calendar_id ?? "primary");
    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(Math.min(Math.max(max_results ?? 25, 1), 100)),
    });
    // Default window: now → +7 days. Keeps "what's on my schedule" cheap.
    const now = new Date();
    const inAWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    params.set("timeMin", time_min ?? now.toISOString());
    params.set("timeMax", time_max ?? inAWeek.toISOString());
    if (query) params.set("q", query);
    const data = await calendarFetch(
      auth,
      `/calendars/${cal}/events?${params.toString()}`,
    ) as { items?: CalendarEvent[]; error?: string };
    if ("error" in data && data.error) return JSON.stringify(data);
    return JSON.stringify({
      events: (data.items ?? []).map(slimEvent),
    });
  },
  {
    name: "calendar_list_events",
    description:
      "List events on a calendar within a time window. Defaults: primary calendar, " +
      "now → +7 days, ordered by start, recurring events expanded into single " +
      "instances. **Use this before creating an event** to avoid double-booking, " +
      "and to look up existing event ids before updating/deleting. " +
      "Datetimes are RFC3339 (e.g. '2026-05-19T16:00:00-07:00').",
    schema: z.object({
      calendar_id: z.string().optional().describe("Calendar id (default: 'primary')"),
      time_min: z.string().optional().describe("RFC3339 lower bound (default: now)"),
      time_max: z.string().optional().describe("RFC3339 upper bound (default: now + 7 days)"),
      query: z.string().optional().describe("Free-text search across event fields"),
      max_results: z.number().int().optional().describe("Max events (default 25, max 100)"),
    }),
  },
);

export const calendarGetEventTool = tool(
  async ({ calendar_id, event_id }) => {
    const auth = resolveGoogleAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const cal = encodeURIComponent(calendar_id ?? "primary");
    const eid = encodeURIComponent(event_id);
    const data = await calendarFetch(auth, `/calendars/${cal}/events/${eid}`) as
      CalendarEvent & { error?: string };
    if (data.error) return JSON.stringify({ error: data.error });
    return JSON.stringify(slimEvent(data));
  },
  {
    name: "calendar_get_event",
    description:
      "Fetch one Google Calendar event by id. Returns the same slim shape as " +
      "calendar_list_events but for a single event.",
    schema: z.object({
      calendar_id: z.string().optional().describe("Calendar id (default: 'primary')"),
      event_id: z.string().describe("Event id (from calendar_list_events results)"),
    }),
  },
);

export const calendarCreateEventTool = tool(
  async ({
    calendar_id, summary, subject, start_iso, end_iso, description, location,
    attendees, time_zone, add_meet_link,
  }) => {
    const auth = resolveGoogleAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const cal = encodeURIComponent(calendar_id ?? "primary");

    // `subject` is accepted as an alias for `summary` so agents trained on
    // Outlook vocabulary don't fail the schema on first try.
    const eventSummary = summary ?? subject;
    if (!eventSummary) {
      return JSON.stringify({ error: "summary (or subject) is required" });
    }

    interface EventBody {
      summary: string;
      description?: string;
      location?: string;
      start: EventDateTime;
      end: EventDateTime;
      attendees?: { email: string }[];
      conferenceData?: {
        createRequest: { requestId: string; conferenceSolutionKey: { type: string } };
      };
    }
    const body: EventBody = {
      summary: eventSummary,
      start: { dateTime: start_iso, ...(time_zone ? { timeZone: time_zone } : {}) },
      end: { dateTime: end_iso, ...(time_zone ? { timeZone: time_zone } : {}) },
    };
    if (description) body.description = description;
    if (location) body.location = location;
    if (attendees && attendees.length > 0) {
      body.attendees = attendees.map((email) => ({ email }));
    }
    if (add_meet_link) {
      body.conferenceData = {
        createRequest: {
          // requestId must be unique per createRequest; Google echoes it back.
          requestId: `jarela-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      };
    }

    // conferenceDataVersion=1 is required for Google to honor the
    // createRequest and provision a Meet URL. Harmless to set without it.
    const params = add_meet_link ? "?conferenceDataVersion=1" : "";
    const data = await calendarFetch(
      auth,
      `/calendars/${cal}/events${params}`,
      { method: "POST", body: JSON.stringify(body) },
    ) as CalendarEvent & { error?: string };
    if (data.error) return JSON.stringify({ error: data.error });
    return JSON.stringify(slimEvent(data));
  },
  {
    name: "calendar_create_event",
    description:
      "Create a Google Calendar event on a calendar (default: 'primary'). " +
      "Datetimes are RFC3339 strings — include a timezone offset (e.g. " +
      "'2026-05-19T16:00:00-07:00') or set `time_zone` to an IANA name (e.g. " +
      "'America/Los_Angeles') so the user's calendar interprets the time " +
      "correctly. Attendees are emailed an invite automatically. Set " +
      "`add_meet_link: true` to provision a Google Meet URL on the event.",
    schema: z.object({
      calendar_id: z.string().optional().describe("Calendar id (default: 'primary')"),
      summary: z.string().min(1).optional().describe("Event title shown on the calendar (alias: subject)"),
      subject: z.string().min(1).optional().describe("Alias for summary (Outlook vocabulary)"),
      start_iso: z.string().describe("Start datetime, RFC3339"),
      end_iso: z.string().describe("End datetime, RFC3339 (must be after start)"),
      description: z.string().optional().describe("Long-form event body (markdown not rendered)"),
      location: z.string().optional().describe("Free-text location string"),
      attendees: z.array(z.string().email()).optional().describe("Invitee email addresses"),
      time_zone: z.string().optional().describe("IANA timezone, e.g. 'America/Los_Angeles'"),
      add_meet_link: z.boolean().optional().describe("Provision a Google Meet URL on this event"),
    }),
  },
);

export const calendarUpdateEventTool = tool(
  async ({
    calendar_id, event_id, summary, subject, start_iso, end_iso, description, location,
    attendees, time_zone,
  }) => {
    const auth = resolveGoogleAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const cal = encodeURIComponent(calendar_id ?? "primary");
    const eid = encodeURIComponent(event_id);

    const patch: Record<string, unknown> = {};
    const eventSummary = summary ?? subject;
    if (eventSummary !== undefined) patch.summary = eventSummary;
    if (description !== undefined) patch.description = description;
    if (location !== undefined) patch.location = location;
    if (start_iso !== undefined) {
      patch.start = { dateTime: start_iso, ...(time_zone ? { timeZone: time_zone } : {}) };
    }
    if (end_iso !== undefined) {
      patch.end = { dateTime: end_iso, ...(time_zone ? { timeZone: time_zone } : {}) };
    }
    if (attendees !== undefined) {
      patch.attendees = attendees.map((email) => ({ email }));
    }
    if (Object.keys(patch).length === 0) {
      return JSON.stringify({ error: "Provide at least one field to update" });
    }

    const data = await calendarFetch(
      auth,
      `/calendars/${cal}/events/${eid}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    ) as CalendarEvent & { error?: string };
    if (data.error) return JSON.stringify({ error: data.error });
    return JSON.stringify(slimEvent(data));
  },
  {
    name: "calendar_update_event",
    description:
      "Patch a Google Calendar event. Only the fields you supply are changed; " +
      "omit fields to leave them alone. Use this to reschedule (`start_iso`/`end_iso`), " +
      "rename (`summary`), or adjust the invitee list (`attendees` — note this " +
      "**replaces** the full list, so include everyone who should remain).",
    schema: z.object({
      calendar_id: z.string().optional().describe("Calendar id (default: 'primary')"),
      event_id: z.string().describe("Event id"),
      summary: z.string().optional().describe("New event title (alias: subject)"),
      subject: z.string().optional().describe("Alias for summary (Outlook vocabulary)"),
      start_iso: z.string().optional().describe("New start datetime, RFC3339"),
      end_iso: z.string().optional().describe("New end datetime, RFC3339"),
      description: z.string().optional().describe("New event body"),
      location: z.string().optional().describe("New location string"),
      attendees: z.array(z.string().email()).optional().describe("Replacement attendee list"),
      time_zone: z.string().optional().describe("IANA timezone applied to start/end"),
    }),
  },
);

export const calendarDeleteEventTool = tool(
  async ({ calendar_id, event_id }) => {
    const auth = resolveGoogleAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const cal = encodeURIComponent(calendar_id ?? "primary");
    const eid = encodeURIComponent(event_id);
    const data = await calendarFetch(
      auth,
      `/calendars/${cal}/events/${eid}`,
      { method: "DELETE" },
    ) as { ok?: boolean; error?: string };
    if (data.error) return JSON.stringify({ error: data.error });
    return JSON.stringify({ ok: true, id: event_id });
  },
  {
    name: "calendar_delete_event",
    description:
      "Delete a Google Calendar event by id. Attendees are notified by default. " +
      "Returns `{ ok: true, id }` on success. Use `calendar_list_events` to find " +
      "the event id first if you only know the title/time.",
    schema: z.object({
      calendar_id: z.string().optional().describe("Calendar id (default: 'primary')"),
      event_id: z.string().describe("Event id to delete"),
    }),
  },
);

registerTools("Calendar", "read", [
  calendarListCalendarsTool, calendarListEventsTool, calendarGetEventTool,
]);
registerTools("Calendar", "execute", [
  calendarCreateEventTool, calendarUpdateEventTool, calendarDeleteEventTool,
]);
