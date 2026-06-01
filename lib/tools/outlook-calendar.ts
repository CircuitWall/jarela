/**
 * Outlook Calendar tools via Microsoft Graph. Mirrors lib/tools/calendar.ts
 * (the Google Calendar set) one-for-one so the agent's mental model
 * carries over between providers.
 *
 * Graph differences vs Google Calendar worth knowing:
 *   - Each event's start/end is { dateTime, timeZone } where timeZone is
 *     a Windows-time-zone string by default ("Pacific Standard Time"),
 *     not IANA. We pass an explicit `Prefer: outlook.timezone="UTC"`
 *     header so reads come back in UTC and the agent doesn't have to
 *     navigate two TZ namespaces.
 *   - Listing events in a window uses /calendarView (auto-expands
 *     recurring series), parallel to Google's `singleEvents=true`.
 *   - Online meetings use `isOnlineMeeting:true` +
 *     `onlineMeetingProvider:"teamsForBusiness"`. Provisioning a Teams
 *     link is gated behind `add_teams_link` to keep create_event cheap
 *     when the agent just wants a plain event.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerTools } from "./registry";
import {
  graphFetch,
  resolveMicrosoftAuth,
} from "@/lib/integrations/microsoft-oauth";

// ── Graph type shapes (minimal subset) ──────────────────────────────────────

interface GraphCalendar {
  id?: string;
  name?: string;
  isDefaultCalendar?: boolean;
  canEdit?: boolean;
  owner?: { name?: string; address?: string };
}

interface GraphDateTimeTimeZone {
  dateTime?: string;
  timeZone?: string;
}

interface GraphAttendee {
  emailAddress?: { name?: string; address?: string };
  status?: { response?: string; time?: string };
  type?: string;
}

interface GraphEvent {
  id?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: "html" | "text"; content?: string };
  start?: GraphDateTimeTimeZone;
  end?: GraphDateTimeTimeZone;
  location?: { displayName?: string };
  attendees?: GraphAttendee[];
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  webLink?: string;
  onlineMeeting?: { joinUrl?: string };
  onlineMeetingProvider?: string;
}

function slimEvent(e: GraphEvent): Record<string, unknown> {
  return {
    id: e.id,
    subject: e.subject ?? null,
    description: e.bodyPreview ?? null,
    location: e.location?.displayName ?? null,
    start: e.start?.dateTime ?? null,
    end: e.end?.dateTime ?? null,
    time_zone: e.start?.timeZone ?? e.end?.timeZone ?? null,
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.emailAddress?.address ?? null,
      name: a.emailAddress?.name ?? null,
      response: a.status?.response ?? null,
    })),
    is_all_day: e.isAllDay === true,
    is_cancelled: e.isCancelled === true,
    show_as: e.showAs ?? null,
    teams_link: e.onlineMeeting?.joinUrl ?? null,
    web_link: e.webLink ?? null,
  };
}

// ── Tools ───────────────────────────────────────────────────────────────────

export const outlookCalendarListCalendarsTool = tool(
  async () => {
    const auth = resolveMicrosoftAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await graphFetch(auth, "/me/calendars") as {
      value?: GraphCalendar[];
      error?: string;
    };
    if ("error" in data && data.error) return JSON.stringify(data);
    return JSON.stringify({
      calendars: (data.value ?? []).map((c) => ({
        id: c.id,
        name: c.name ?? null,
        is_default: c.isDefaultCalendar === true,
        can_edit: c.canEdit === true,
        owner: c.owner?.address ?? null,
      })),
    });
  },
  {
    name: "outlook_calendar_list_calendars",
    description:
      "List the user's Outlook calendars (primary + shared). Returns id, name, " +
      "is_default flag, edit permission, owner. The `id` is what other " +
      "outlook_calendar_* tools expect as `calendar_id`. Omit `calendar_id` " +
      "in those tools to use the user's default calendar.",
    schema: z.object({}),
  },
);

export const outlookCalendarListEventsTool = tool(
  async ({ calendar_id, time_min, time_max, max_results }) => {
    const auth = resolveMicrosoftAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const now = new Date();
    const inAWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const startISO = time_min ?? now.toISOString();
    const endISO = time_max ?? inAWeek.toISOString();
    const top = Math.min(Math.max(max_results ?? 25, 1), 100);
    // /calendarView expands recurring series into individual instances —
    // the closest parallel to Google's singleEvents=true.
    const base = calendar_id
      ? `/me/calendars/${encodeURIComponent(calendar_id)}/calendarView`
      : "/me/calendarView";
    const params = new URLSearchParams({
      startDateTime: startISO,
      endDateTime: endISO,
      $top: String(top),
      $orderby: "start/dateTime",
    });
    const data = await graphFetch(auth, `${base}?${params.toString()}`, {
      // Force UTC in responses so the agent doesn't juggle Windows-TZ names.
      headers: { Prefer: 'outlook.timezone="UTC"' },
    }) as { value?: GraphEvent[]; error?: string };
    if ("error" in data && data.error) return JSON.stringify(data);
    return JSON.stringify({
      events: (data.value ?? []).map(slimEvent),
    });
  },
  {
    name: "outlook_calendar_list_events",
    description:
      "List Outlook calendar events within a time window. Defaults: default " +
      "calendar, now → +7 days, ordered by start, recurring series expanded. " +
      "**Use this before creating an event** to avoid double-booking, and to " +
      "look up event ids before updating/deleting. All datetimes returned in " +
      "UTC (RFC3339 'Z'-suffixed).",
    schema: z.object({
      calendar_id: z.string().optional().describe("Calendar id (default: user's default calendar)"),
      time_min: z.string().optional().describe("RFC3339 lower bound (default: now)"),
      time_max: z.string().optional().describe("RFC3339 upper bound (default: now + 7 days)"),
      max_results: z.number().int().optional().describe("Max events (default 25, max 100)"),
    }),
  },
);

export const outlookCalendarGetEventTool = tool(
  async ({ event_id }) => {
    const auth = resolveMicrosoftAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const e = await graphFetch(auth, `/me/events/${encodeURIComponent(event_id)}`, {
      headers: { Prefer: 'outlook.timezone="UTC"' },
    }) as GraphEvent & { error?: string };
    if (e.error) return JSON.stringify({ error: e.error });
    return JSON.stringify(slimEvent(e));
  },
  {
    name: "outlook_calendar_get_event",
    description:
      "Fetch one Outlook calendar event by id. Returns the same slim shape as " +
      "outlook_calendar_list_events but for a single event.",
    schema: z.object({
      event_id: z.string().describe("Event id (from outlook_calendar_list_events)"),
    }),
  },
);

export const outlookCalendarCreateEventTool = tool(
  async ({
    calendar_id, subject, summary, start_iso, end_iso, description, location,
    attendees, time_zone, add_teams_link,
  }) => {
    const auth = resolveMicrosoftAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });

    // `summary` is accepted as an alias for `subject` so agents trained on
    // Google Calendar's vocabulary don't fail the schema on first try.
    const eventSubject = subject ?? summary;
    if (!eventSubject) {
      return JSON.stringify({ error: "subject (or summary) is required" });
    }

    interface EventBody {
      subject: string;
      body?: { contentType: "text"; content: string };
      start: GraphDateTimeTimeZone;
      end: GraphDateTimeTimeZone;
      location?: { displayName: string };
      attendees?: Array<{ emailAddress: { address: string }; type: "required" }>;
      isOnlineMeeting?: boolean;
      onlineMeetingProvider?: string;
    }
    // Graph uses Windows TZ names by default but also accepts IANA names
    // when the body specifies them per-field. Default to UTC if the
    // caller omits time_zone (matches the list endpoint's behavior).
    const tz = time_zone ?? "UTC";
    const body: EventBody = {
      subject: eventSubject,
      start: { dateTime: start_iso, timeZone: tz },
      end: { dateTime: end_iso, timeZone: tz },
    };
    if (description) body.body = { contentType: "text", content: description };
    if (location) body.location = { displayName: location };
    if (attendees && attendees.length > 0) {
      body.attendees = attendees.map((address) => ({
        emailAddress: { address },
        type: "required" as const,
      }));
    }
    if (add_teams_link) {
      body.isOnlineMeeting = true;
      body.onlineMeetingProvider = "teamsForBusiness";
    }

    const path = calendar_id
      ? `/me/calendars/${encodeURIComponent(calendar_id)}/events`
      : "/me/events";
    const r = await graphFetch(auth, path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { Prefer: 'outlook.timezone="UTC"' },
    }) as GraphEvent & { error?: string };
    if (r.error) return JSON.stringify({ error: r.error });
    return JSON.stringify(slimEvent(r));
  },
  {
    name: "outlook_calendar_create_event",
    description:
      "Create an Outlook calendar event. Datetimes are RFC3339 strings; pair " +
      "with `time_zone` (IANA like 'America/Los_Angeles' or Windows TZ like " +
      "'Pacific Standard Time') so Outlook interprets them correctly. Defaults " +
      "to UTC if omitted. Attendees are automatically sent invites. Set " +
      "`add_teams_link: true` to provision a Teams meeting URL (requires a " +
      "work/school M365 account; personal Microsoft accounts cannot create " +
      "Teams meetings via Graph).",
    schema: z.object({
      calendar_id: z.string().optional().describe("Calendar id (default: user's default calendar)"),
      subject: z.string().min(1).optional().describe("Event title shown on the calendar (alias: summary)"),
      summary: z.string().min(1).optional().describe("Alias for subject (Google Calendar vocabulary)"),
      start_iso: z.string().describe("Start datetime, RFC3339"),
      end_iso: z.string().describe("End datetime, RFC3339 (must be after start)"),
      description: z.string().optional().describe("Long-form event body (plain text)"),
      location: z.string().optional().describe("Free-text location string"),
      attendees: z.array(z.string().email()).optional().describe("Invitee email addresses"),
      time_zone: z.string().optional().describe("IANA or Windows timezone (default 'UTC')"),
      add_teams_link: z.boolean().optional().describe("Provision a Teams meeting URL on this event"),
    }),
  },
);

export const outlookCalendarUpdateEventTool = tool(
  async ({
    event_id, subject, summary, start_iso, end_iso, description, location,
    attendees, time_zone,
  }) => {
    const auth = resolveMicrosoftAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });

    const tz = time_zone ?? "UTC";
    const patch: Record<string, unknown> = {};
    const eventSubject = subject ?? summary;
    if (eventSubject !== undefined) patch.subject = eventSubject;
    if (description !== undefined) patch.body = { contentType: "text", content: description };
    if (location !== undefined) patch.location = { displayName: location };
    if (start_iso !== undefined) patch.start = { dateTime: start_iso, timeZone: tz };
    if (end_iso !== undefined) patch.end = { dateTime: end_iso, timeZone: tz };
    if (attendees !== undefined) {
      patch.attendees = attendees.map((address) => ({
        emailAddress: { address },
        type: "required" as const,
      }));
    }
    if (Object.keys(patch).length === 0) {
      return JSON.stringify({ error: "Provide at least one field to update" });
    }

    const r = await graphFetch(
      auth,
      `/me/events/${encodeURIComponent(event_id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
        headers: { Prefer: 'outlook.timezone="UTC"' },
      },
    ) as GraphEvent & { error?: string };
    if (r.error) return JSON.stringify({ error: r.error });
    return JSON.stringify(slimEvent(r));
  },
  {
    name: "outlook_calendar_update_event",
    description:
      "Patch an Outlook calendar event. Only supplied fields are changed; omit " +
      "fields to leave them alone. Note `attendees` REPLACES the full invitee " +
      "list, so include everyone who should remain.",
    schema: z.object({
      event_id: z.string().describe("Event id"),
      subject: z.string().optional().describe("New event title (alias: summary)"),
      summary: z.string().optional().describe("Alias for subject (Google Calendar vocabulary)"),
      start_iso: z.string().optional().describe("New start datetime, RFC3339"),
      end_iso: z.string().optional().describe("New end datetime, RFC3339"),
      description: z.string().optional().describe("New event body (plain text)"),
      location: z.string().optional().describe("New location string"),
      attendees: z.array(z.string().email()).optional().describe("Replacement attendee list"),
      time_zone: z.string().optional().describe("IANA or Windows TZ applied to start/end (default 'UTC')"),
    }),
  },
);

export const outlookCalendarDeleteEventTool = tool(
  async ({ event_id }) => {
    const auth = resolveMicrosoftAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const r = await graphFetch(
      auth,
      `/me/events/${encodeURIComponent(event_id)}`,
      { method: "DELETE" },
    ) as { ok?: boolean; error?: string };
    if (r.error) return JSON.stringify({ error: r.error });
    return JSON.stringify({ ok: true, id: event_id });
  },
  {
    name: "outlook_calendar_delete_event",
    description:
      "Delete an Outlook calendar event by id. Attendees are notified. Returns " +
      "`{ ok: true, id }` on success. Use outlook_calendar_list_events to find " +
      "the event id first if you only know the title/time.",
    schema: z.object({
      event_id: z.string().describe("Event id to delete"),
    }),
  },
);

registerTools("Calendar", [
  outlookCalendarListCalendarsTool, outlookCalendarListEventsTool,
  outlookCalendarGetEventTool, outlookCalendarCreateEventTool,
  outlookCalendarUpdateEventTool, outlookCalendarDeleteEventTool,
]);
