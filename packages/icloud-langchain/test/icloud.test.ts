import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `imapflow.ImapFlow` is a class, so we replace it with a vi.fn() and
// route each test through `setImap(...)` to inject the per-test instance.
// `tsdav.createDAVClient` is a function, mocked the same way via setDav.

let _nextImap: Record<string, unknown> | null = null;
let _nextDav: Record<string, unknown> | null = null;
let _lastImapCtorOpts: { auth?: { user: string; pass: string } } | null = null;

vi.mock("imapflow", () => {
  // ImapFlow is `new`-ed inside the package. Returning an object from a
  // constructor overrides `this`, which is exactly what we need to
  // forward calls to the per-test fake.
  class ImapFlow {
    constructor(opts: { auth?: { user: string; pass: string } }) {
      _lastImapCtorOpts = opts;
      return (_nextImap ?? {}) as ImapFlow;
    }
  }
  return { ImapFlow };
});

vi.mock("tsdav", () => ({
  createDAVClient: vi.fn(async () => _nextDav ?? {}),
}));

function setImap(instance: Record<string, unknown>): void {
  _nextImap = {
    connect: async () => undefined,
    logout: async () => undefined,
    ...instance,
  };
}

function setDav(client: Record<string, unknown>): void {
  _nextDav = client;
}

function fakeLock(): { release: () => void } {
  return { release: () => undefined };
}

import {
  _resetCalDAVCache,
  icloudCalendarCreateEventTool,
  icloudCalendarDeleteEventTool,
  icloudCalendarListCalendarsTool,
  icloudCalendarListEventsTool,
  icloudCalendarUpdateEventTool,
  icloudMailCreateDraftTool,
  icloudMailDeleteMessageTool,
  icloudMailFlagMessageTool,
  icloudMailListFoldersTool,
  icloudMailListMessagesTool,
  icloudRemindersCompleteTool,
  icloudRemindersCreateTool,
  icloudRemindersListListsTool,
  resolveICloudAuthFromEnv,
  setAuthResolver,
} from "../src/index.js";

beforeEach(() => {
  _nextImap = null;
  _nextDav = null;
  _lastImapCtorOpts = null;
  _resetCalDAVCache();
  process.env.ICLOUD_APPLE_ID = "tester@icloud.com";
  process.env.ICLOUD_APP_PASSWORD = "abcd-efgh-ijkl-mnop";
  setAuthResolver(resolveICloudAuthFromEnv);
});

afterEach(() => {
  delete process.env.ICLOUD_APPLE_ID;
  delete process.env.ICLOUD_APP_PASSWORD;
});

describe("auth resolver", () => {
  it("strips dashes from the app password and uses short-name for IMAP login", async () => {
    setImap({ list: async () => [] });
    await icloudMailListFoldersTool.invoke({});
    expect(_lastImapCtorOpts).not.toBeNull();
    expect(_lastImapCtorOpts!.auth!.user).toBe("tester");
    expect(_lastImapCtorOpts!.auth!.pass).toBe("abcdefghijklmnop");
  });

  it("reports a friendly error when env vars are missing", async () => {
    delete process.env.ICLOUD_APPLE_ID;
    delete process.env.ICLOUD_APP_PASSWORD;
    setAuthResolver(resolveICloudAuthFromEnv);
    const out = await icloudMailListFoldersTool.invoke({});
    expect(JSON.parse(out as string).error).toMatch(/ICLOUD_APPLE_ID/);
  });
});

describe("icloud_mail_list_folders", () => {
  it("returns folder metadata including SPECIAL-USE flags", async () => {
    setImap({
      list: async () => [
        {
          path: "INBOX",
          name: "INBOX",
          delimiter: "/",
          specialUse: undefined,
          subscribed: true,
          status: { messages: 42, unseen: 3 },
        },
        {
          path: "Drafts",
          name: "Drafts",
          delimiter: "/",
          specialUse: "\\Drafts",
          subscribed: true,
          status: { messages: 1, unseen: 0 },
        },
      ],
    });
    const out = await icloudMailListFoldersTool.invoke({});
    const parsed = JSON.parse(out as string);
    expect(parsed.folders).toHaveLength(2);
    expect(parsed.folders[0]).toMatchObject({
      path: "INBOX",
      messages: 42,
      unseen: 3,
      special_use: null,
    });
    expect(parsed.folders[1].special_use).toBe("\\Drafts");
  });
});

describe("icloud_mail_list_messages", () => {
  it("searches UIDs and returns most-recent-first envelope summaries", async () => {
    const fetchedUids: number[] = [];
    setImap({
      getMailboxLock: async () => fakeLock(),
      search: async () => [10, 11, 12],
      fetch: function* (uids: number[]) {
        for (const uid of uids) {
          fetchedUids.push(uid);
          yield {
            uid,
            envelope: {
              subject: `Subject ${uid}`,
              from: [{ name: "Sender", address: `from${uid}@x` }],
              date: new Date("2026-06-20T12:00:00Z"),
            },
            flags: new Set(["\\Seen"]),
            size: 1024,
          };
        }
      },
    });
    const out = await icloudMailListMessagesTool.invoke({ limit: 5 });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages).toHaveLength(3);
    expect(fetchedUids).toEqual([12, 11, 10]);
    expect(parsed.messages[0]).toMatchObject({
      uid: 12,
      subject: "Subject 12",
      from: "Sender <from12@x>",
    });
  });

  // iCloud rejects IMAP SEARCH with no criteria as "Command failed".
  // The tool must substitute { all: true } when the caller passes no
  // filters so the default "give me the most recent N" works.
  it("passes { all: true } when no filters are supplied", async () => {
    let observed: unknown = null;
    setImap({
      getMailboxLock: async () => fakeLock(),
      search: async (criteria: unknown) => {
        observed = criteria;
        return [1];
      },
      fetch: function* () {
        yield {
          uid: 1,
          envelope: { subject: "x", from: [], date: new Date() },
          flags: new Set(),
          size: 0,
        };
      },
    });
    await icloudMailListMessagesTool.invoke({ limit: 10 });
    expect(observed).toEqual({ all: true });
  });

  it("returns an empty list (no IMAP fetch) when search matches nothing", async () => {
    let fetched = false;
    setImap({
      getMailboxLock: async () => fakeLock(),
      search: async () => [],
      fetch: function* () {
        fetched = true;
      },
    });
    const out = await icloudMailListMessagesTool.invoke({ query: "needle", limit: 10 });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages).toEqual([]);
    expect(fetched).toBe(false);
  });
});

describe("icloud_mail_flag_message", () => {
  it("adds Seen and removes Flagged when seen=true, flagged=false", async () => {
    const adds: string[][] = [];
    const removes: string[][] = [];
    setImap({
      getMailboxLock: async () => fakeLock(),
      messageFlagsAdd: async (_: string, flags: string[]) => {
        adds.push(flags);
        return true;
      },
      messageFlagsRemove: async (_: string, flags: string[]) => {
        removes.push(flags);
        return true;
      },
    });
    const out = await icloudMailFlagMessageTool.invoke({
      mailbox: "INBOX",
      uid: 5,
      seen: true,
      flagged: false,
    });
    expect(adds).toEqual([["\\Seen"]]);
    expect(removes).toEqual([["\\Flagged"]]);
    expect(JSON.parse(out as string)).toMatchObject({ added: ["\\Seen"] });
  });

  it("returns an error when neither seen nor flagged is supplied", async () => {
    setImap({ getMailboxLock: async () => fakeLock() });
    const out = await icloudMailFlagMessageTool.invoke({ mailbox: "INBOX", uid: 5 });
    expect(JSON.parse(out as string).error).toMatch(/seen\/flagged/);
  });
});

describe("icloud_mail_delete_message", () => {
  it("moves to the SPECIAL-USE \\Trash mailbox", async () => {
    let movedTo: string | null = null;
    setImap({
      getMailboxLock: async () => fakeLock(),
      list: async () => [
        { path: "INBOX", specialUse: undefined },
        { path: "Deleted Messages", specialUse: "\\Trash" },
      ],
      messageMove: async (_: string, target: string) => {
        movedTo = target;
        return { destination: target, uidMap: new Map() };
      },
    });
    const out = await icloudMailDeleteMessageTool.invoke({ mailbox: "INBOX", uid: 9 });
    expect(movedTo).toBe("Deleted Messages");
    expect(JSON.parse(out as string)).toMatchObject({ trashed_to: "Deleted Messages" });
  });

  it("errors when no \\Trash folder is advertised", async () => {
    setImap({
      getMailboxLock: async () => fakeLock(),
      list: async () => [{ path: "INBOX", specialUse: undefined }],
    });
    const out = await icloudMailDeleteMessageTool.invoke({ mailbox: "INBOX", uid: 9 });
    expect(JSON.parse(out as string).error).toMatch(/Trash/);
  });
});

describe("icloud_mail_create_draft", () => {
  it("APPENDs an RFC822 message into the SPECIAL-USE \\Drafts mailbox", async () => {
    let appended: { mailbox: string; rfc822: string; flags: string[] } | null = null;
    setImap({
      list: async () => [
        { path: "INBOX", specialUse: undefined },
        { path: "Drafts", specialUse: "\\Drafts" },
      ],
      append: async (mailbox: string, rfc822: string, flags: string[]) => {
        appended = { mailbox, rfc822, flags };
        return { uid: 99, path: mailbox };
      },
    });
    const out = await icloudMailCreateDraftTool.invoke({
      to: ["bob@example.com"],
      subject: "Hello",
      body_text: "Body content",
    });
    expect(appended).not.toBeNull();
    expect(appended!.mailbox).toBe("Drafts");
    expect(appended!.flags).toEqual(["\\Draft"]);
    expect(appended!.rfc822).toContain("From: tester@icloud.com");
    expect(appended!.rfc822).toContain("To: bob@example.com");
    expect(appended!.rfc822).toContain("Subject: Hello");
    expect(JSON.parse(out as string)).toMatchObject({ ok: true, mailbox: "Drafts", uid: 99 });
  });

  it("RFC2047-encodes non-ASCII subjects", async () => {
    let appendedSubject: string | null = null;
    setImap({
      list: async () => [{ path: "Drafts", specialUse: "\\Drafts" }],
      append: async (_: string, rfc822: string) => {
        const m = /^Subject: (.+)$/m.exec(rfc822);
        appendedSubject = m ? m[1] : null;
        return { uid: 1, path: "Drafts" };
      },
    });
    await icloudMailCreateDraftTool.invoke({
      to: ["bob@example.com"],
      subject: "Café résumé",
      body_text: "x",
    });
    expect(appendedSubject).toMatch(/^=\?UTF-8\?B\?/);
  });
});

describe("icloud_calendar_list_calendars", () => {
  it("filters to VEVENT collections", async () => {
    setDav({
      fetchCalendars: async () => [
        {
          url: "https://caldav.icloud.com/123/calendars/home/",
          displayName: "Home",
          components: ["VEVENT"],
          calendarColor: "#ff0000",
          description: "personal",
          ctag: "abc",
        },
        {
          url: "https://caldav.icloud.com/123/calendars/work/",
          displayName: "Reminders",
          components: ["VTODO"],
        },
      ],
    });
    const out = await icloudCalendarListCalendarsTool.invoke({});
    const parsed = JSON.parse(out as string);
    expect(parsed.calendars.map((c: { display_name: string }) => c.display_name)).toEqual([
      "Home",
    ]);
    expect(parsed.calendars[0]).toMatchObject({
      url: "https://caldav.icloud.com/123/calendars/home/",
      color: "#ff0000",
      ctag: "abc",
    });
  });
});

describe("icloud_calendar_list_events", () => {
  it("parses iCalendar VEVENTs into a JSON summary with recurrence info", async () => {
    const ics =
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n" +
      "UID:ev-1\r\nSUMMARY:Standup\r\nLOCATION:Zoom\r\n" +
      "DTSTART:20260620T140000Z\r\nDTEND:20260620T143000Z\r\n" +
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\r\n" +
      "END:VEVENT\r\nEND:VCALENDAR\r\n";
    setDav({
      fetchCalendarObjects: async () => [
        { url: "https://caldav.icloud.com/123/calendars/home/ev-1.ics", data: ics, etag: "1" },
      ],
    });
    const out = await icloudCalendarListEventsTool.invoke({
      calendar_url: "https://caldav.icloud.com/123/calendars/home/",
      time_min: "2026-06-01T00:00:00Z",
      time_max: "2026-07-01T00:00:00Z",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({
      uid: "ev-1",
      summary: "Standup",
      location: "Zoom",
      is_recurring: true,
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
    });
  });
});

describe("icloud_calendar_create_event", () => {
  it("serialises a VEVENT and POSTs it via createCalendarObject", async () => {
    let posted: { filename: string; ics: string } | null = null;
    setDav({
      createCalendarObject: async ({
        filename,
        iCalString,
      }: {
        filename: string;
        iCalString: string;
      }) => {
        posted = { filename, ics: iCalString };
        return { ok: true } as unknown;
      },
    });
    const out = await icloudCalendarCreateEventTool.invoke({
      calendar_url: "https://caldav.icloud.com/123/calendars/home/",
      summary: "Lunch",
      start: "2026-06-20T12:00:00Z",
      end: "2026-06-20T13:00:00Z",
      location: "Cafe",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.uid).toMatch(/@jarela\.icloud$/);
    expect(posted).not.toBeNull();
    expect(posted!.filename).toMatch(/\.ics$/);
    expect(posted!.ics).toContain("BEGIN:VEVENT");
    expect(posted!.ics).toContain("SUMMARY:Lunch");
    expect(posted!.ics).toContain("LOCATION:Cafe");
    expect(posted!.ics).toContain("DTSTART:20260620T120000Z");
  });

  it("emits DTSTART;VALUE=DATE for all-day events", async () => {
    let postedIcs: string | null = null;
    setDav({
      createCalendarObject: async ({ iCalString }: { iCalString: string }) => {
        postedIcs = iCalString;
        return { ok: true } as unknown;
      },
    });
    await icloudCalendarCreateEventTool.invoke({
      calendar_url: "https://caldav.icloud.com/123/calendars/home/",
      summary: "Holiday",
      start: "2026-12-25",
      end: "2026-12-26",
      all_day: true,
    });
    expect(postedIcs).toContain("DTSTART;VALUE=DATE:20261225");
    expect(postedIcs).toContain("DTEND;VALUE=DATE:20261226");
  });

  it("includes RRULE when rrule parameter is supplied", async () => {
    let postedIcs: string | null = null;
    setDav({
      createCalendarObject: async ({ iCalString }: { iCalString: string }) => {
        postedIcs = iCalString;
        return { ok: true } as unknown;
      },
    });
    await icloudCalendarCreateEventTool.invoke({
      calendar_url: "https://caldav.icloud.com/123/calendars/home/",
      summary: "Weekly Sync",
      start: "2026-06-20T10:00:00Z",
      end: "2026-06-20T10:30:00Z",
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE",
    });
    expect(postedIcs).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO,WE");
  });

  it("includes primary/secondary alerts and travel time when supplied", async () => {
    let postedIcs: string | null = null;
    setDav({
      createCalendarObject: async ({ iCalString }: { iCalString: string }) => {
        postedIcs = iCalString;
        return { ok: true } as unknown;
      },
    });
    await icloudCalendarCreateEventTool.invoke({
      calendar_url: "https://caldav.icloud.com/123/calendars/home/",
      summary: "Dentist",
      start: "2026-06-20T10:00:00Z",
      end: "2026-06-20T11:00:00Z",
      alerts: ["15m", "1h"],
      travel_time: "30m",
      url: "https://clinic.example.com",
      status: "CONFIRMED",
      availability: "busy",
    });
    expect(postedIcs).toContain("X-APPLE-TRAVEL-DURATION;VALUE=DURATION:PT30M");
    expect(postedIcs).toContain("TRIGGER:-PT15M");
    expect(postedIcs).toContain("TRIGGER:-PT1H");
    expect(postedIcs).toContain("URL:https://clinic.example.com");
    expect(postedIcs).toContain("STATUS:CONFIRMED");
    expect(postedIcs).toContain("TRANSP:OPAQUE");
  });
});

describe("icloud_calendar_update_event", () => {
  it("patches LAST-MODIFIED as a DATE-TIME property", async () => {
    const ics =
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n" +
      "UID:ev-update\r\nSUMMARY:Old\r\nDTSTART:20260620T140000Z\r\nDTEND:20260620T143000Z\r\n" +
      "END:VEVENT\r\nEND:VCALENDAR\r\n";
    let updatedIcs: string | null = null;
    setDav({
      fetchCalendarObjects: async () => [
        { url: "https://x/ev-update.ics", data: ics, etag: "1" },
      ],
      updateCalendarObject: async ({
        calendarObject,
      }: {
        calendarObject: { data?: string };
      }) => {
        updatedIcs = calendarObject.data ?? null;
        return { ok: true } as unknown;
      },
    });
    const out = await icloudCalendarUpdateEventTool.invoke({
      calendar_url: "https://caldav.icloud.com/123/calendars/home/",
      uid: "ev-update",
      summary: "New",
    });

    expect(JSON.parse(out as string)).toMatchObject({ updated: true, uid: "ev-update" });
    expect(updatedIcs).toContain("SUMMARY:New");
    expect(updatedIcs).toMatch(/LAST-MODIFIED:\d{8}T\d{6}Z/);
  });

  it("updates and removes RRULE on existing event", async () => {
    const ics =
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n" +
      "UID:ev-rrule\r\nSUMMARY:Recurring\r\nDTSTART:20260620T140000Z\r\nDTEND:20260620T143000Z\r\n" +
      "RRULE:FREQ=DAILY\r\n" +
      "END:VEVENT\r\nEND:VCALENDAR\r\n";
    let updatedIcs: string | null = null;
    setDav({
      fetchCalendarObjects: async () => [
        { url: "https://x/ev-rrule.ics", data: ics, etag: "1" },
      ],
      updateCalendarObject: async ({
        calendarObject,
      }: {
        calendarObject: { data?: string };
      }) => {
        updatedIcs = calendarObject.data ?? null;
        return { ok: true } as unknown;
      },
    });

    // Update rrule
    await icloudCalendarUpdateEventTool.invoke({
      calendar_url: "https://caldav.icloud.com/123/calendars/home/",
      uid: "ev-rrule",
      rrule: "FREQ=WEEKLY;BYDAY=FR",
    });
    expect(updatedIcs).toContain("RRULE:FREQ=WEEKLY;BYDAY=FR");

    // Remove rrule
    await icloudCalendarUpdateEventTool.invoke({
      calendar_url: "https://caldav.icloud.com/123/calendars/home/",
      uid: "ev-rrule",
      rrule: "NONE",
    });
    expect(updatedIcs).not.toContain("RRULE:");
  });

  it("updates and removes alerts and travel time on existing event", async () => {
    const ics =
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n" +
      "UID:ev-extra\r\nSUMMARY:Existing\r\nDTSTART:20260620T140000Z\r\nDTEND:20260620T143000Z\r\n" +
      "X-APPLE-TRAVEL-DURATION;VALUE=DURATION:PT15M\r\n" +
      "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\n" +
      "END:VEVENT\r\nEND:VCALENDAR\r\n";
    let updatedIcs: string | null = null;
    setDav({
      fetchCalendarObjects: async () => [
        { url: "https://x/ev-extra.ics", data: ics, etag: "1" },
      ],
      updateCalendarObject: async ({
        calendarObject,
      }: {
        calendarObject: { data?: string };
      }) => {
        updatedIcs = calendarObject.data ?? null;
        return { ok: true } as unknown;
      },
    });

    // Update travel time & alerts
    await icloudCalendarUpdateEventTool.invoke({
      calendar_url: "https://caldav.icloud.com/123/calendars/home/",
      uid: "ev-extra",
      travel_time: "45m",
      alerts: ["30m", "2h"],
    });
    expect(updatedIcs).toContain("X-APPLE-TRAVEL-DURATION;VALUE=DURATION:PT45M");
    expect(updatedIcs).toContain("TRIGGER:-PT30M");
    expect(updatedIcs).toContain("TRIGGER:-PT2H");

    // Remove travel time & alerts
    await icloudCalendarUpdateEventTool.invoke({
      calendar_url: "https://caldav.icloud.com/123/calendars/home/",
      uid: "ev-extra",
      travel_time: "NONE",
      alerts: ["NONE"],
    });
    expect(updatedIcs).not.toContain("X-APPLE-TRAVEL-DURATION");
    expect(updatedIcs).not.toContain("BEGIN:VALARM");
  });
});

describe("icloud_calendar_delete_event", () => {
  it("finds the matching iCal object by UID and deletes it", async () => {
    const ics =
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n" +
      "UID:ev-keep\r\nSUMMARY:Keep\r\nDTSTART:20260620T140000Z\r\nDTEND:20260620T143000Z\r\n" +
      "END:VEVENT\r\nEND:VCALENDAR\r\n";
    const ics2 =
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n" +
      "UID:ev-delete\r\nSUMMARY:Bye\r\nDTSTART:20260620T140000Z\r\nDTEND:20260620T143000Z\r\n" +
      "END:VEVENT\r\nEND:VCALENDAR\r\n";
    let deletedUrl: string | null = null;
    setDav({
      fetchCalendarObjects: async () => [
        { url: "https://x/ev-keep.ics", data: ics, etag: "1" },
        { url: "https://x/ev-delete.ics", data: ics2, etag: "2" },
      ],
      deleteCalendarObject: async ({
        calendarObject,
      }: {
        calendarObject: { url: string };
      }) => {
        deletedUrl = calendarObject.url;
        return { ok: true } as unknown;
      },
    });
    const out = await icloudCalendarDeleteEventTool.invoke({
      calendar_url: "https://caldav.icloud.com/123/calendars/home/",
      uid: "ev-delete",
    });
    expect(deletedUrl).toBe("https://x/ev-delete.ics");
    expect(JSON.parse(out as string)).toMatchObject({ deleted: true, uid: "ev-delete" });
  });
});

describe("icloud_reminders_list_lists", () => {
  it("filters to VTODO collections", async () => {
    setDav({
      fetchCalendars: async () => [
        { url: "https://x/home/", displayName: "Home", components: ["VEVENT"] },
        { url: "https://x/todo/", displayName: "Tasks", components: ["VTODO"] },
      ],
    });
    const out = await icloudRemindersListListsTool.invoke({});
    const parsed = JSON.parse(out as string);
    expect(parsed.lists.map((l: { display_name: string }) => l.display_name)).toEqual(["Tasks"]);
  });
});

describe("icloud_reminders_create", () => {
  it("emits a VTODO with NEEDS-ACTION status", async () => {
    let postedIcs: string | null = null;
    setDav({
      createCalendarObject: async ({ iCalString }: { iCalString: string }) => {
        postedIcs = iCalString;
        return { ok: true } as unknown;
      },
    });
    const out = await icloudRemindersCreateTool.invoke({
      calendar_url: "https://x/todo/",
      summary: "Buy milk",
    });
    expect(postedIcs).toContain("BEGIN:VTODO");
    expect(postedIcs).toContain("SUMMARY:Buy milk");
    expect(postedIcs).toContain("STATUS:NEEDS-ACTION");
    expect(JSON.parse(out as string).uid).toMatch(/@jarela\.icloud$/);
  });
});

describe("icloud_reminders_complete", () => {
  it("rewrites STATUS to COMPLETED and persists", async () => {
    const todoIcs =
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\n" +
      "UID:todo-1\r\nSUMMARY:Buy milk\r\nSTATUS:NEEDS-ACTION\r\n" +
      "END:VTODO\r\nEND:VCALENDAR\r\n";
    let updatedIcs: string | null = null;
    setDav({
      fetchCalendarObjects: async () => [
        { url: "https://x/todo/todo-1.ics", data: todoIcs, etag: "1" },
      ],
      updateCalendarObject: async ({
        calendarObject,
      }: {
        calendarObject: { data: string };
      }) => {
        updatedIcs = calendarObject.data;
        return { ok: true } as unknown;
      },
    });
    const out = await icloudRemindersCompleteTool.invoke({
      calendar_url: "https://x/todo/",
      uid: "todo-1",
    });
    expect(updatedIcs).toContain("STATUS:COMPLETED");
    expect(updatedIcs).toContain("PERCENT-COMPLETE:100");
    expect(JSON.parse(out as string)).toMatchObject({ completed: true, uid: "todo-1" });
  });
});
