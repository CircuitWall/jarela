import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  graphFetch: vi.fn(),
  googleFetch: vi.fn(),
  authError: null as string | null,
}));

vi.mock("@/lib/integrations/microsoft-oauth", () => ({
  resolveMicrosoftAuth: () => (mocks.authError ? { error: mocks.authError } : { token: "t" }),
  graphFetch: mocks.graphFetch,
}));
vi.mock("@/lib/integrations/gmail-oauth", () => ({
  resolveGoogleAuth: () => (mocks.authError ? { error: mocks.authError } : { token: "t" }),
  googleFetch: mocks.googleFetch,
}));

const outlook = await import("./outlook-calendar");
const google = await import("./calendar");

type Invokable = { invoke: (args: never) => Promise<unknown> };
async function call(t: Invokable, args: Record<string, unknown>) {
  return JSON.parse(String(await t.invoke(args as never)));
}

const cases: Array<[string, Invokable, Invokable, ReturnType<typeof vi.fn>, Record<string, unknown>]> = [
  ["outlook", outlook.outlookCalendarCreateEventTool, outlook.outlookCalendarUpdateEventTool, mocks.graphFetch, { subject: "Sync" }],
  ["google", google.calendarCreateEventTool, google.calendarUpdateEventTool, mocks.googleFetch, { summary: "Sync" }],
];

describe.each(cases)("%s calendar write tools as used by an agent", (_name, create, update, fetchMock, title) => {
  beforeEach(() => {
    mocks.authError = null;
    mocks.graphFetch.mockReset().mockResolvedValue({ id: "evt-1" });
    mocks.googleFetch.mockReset().mockResolvedValue({ id: "evt-1" });
  });

  it("creates an event with a valid window", async () => {
    const result = await call(create, { ...title, start_iso: "2026-03-01T10:00:00Z", end_iso: "2026-03-01T11:00:00Z" });
    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ends before it starts", "2026-03-01T11:00:00Z", "2026-03-01T10:00:00Z"],
    ["has zero length", "2026-03-01T10:00:00Z", "2026-03-01T10:00:00Z"],
    ["ends before it starts across offsets", "2026-03-01T10:00:00-05:00", "2026-03-01T14:30:00Z"],
  ])("refuses to create an event that %s, without sending invites", async (_label, start_iso, end_iso) => {
    const result = await call(create, { ...title, start_iso, end_iso, attendees: ["friend@example.com"] });
    expect(result.error).toMatch(/end_iso must be after start_iso/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an inverted reschedule when both bounds are supplied", async () => {
    const result = await call(update, { event_id: "evt-1", start_iso: "2026-03-01T12:00:00Z", end_iso: "2026-03-01T09:00:00Z" });
    expect(result.error).toMatch(/end_iso must be after start_iso/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows moving a single bound because the stored other bound is unknown", async () => {
    await call(update, { event_id: "evt-1", end_iso: "2026-03-01T09:00:00Z" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires at least one update field without calling the provider", async () => {
    expect((await call(update, { event_id: "evt-1" })).error).toMatch(/at least one field/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports missing credentials without calling the provider", async () => {
    mocks.authError = "not connected";
    expect(await call(create, { ...title, start_iso: "2026-03-01T10:00:00Z", end_iso: "2026-03-01T11:00:00Z" })).toEqual({ error: "not connected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes provider errors through instead of claiming success", async () => {
    fetchMock.mockResolvedValue({ error: "403 Forbidden" });
    expect(await call(create, { ...title, start_iso: "2026-03-01T10:00:00Z", end_iso: "2026-03-01T11:00:00Z" })).toEqual({ error: "403 Forbidden" });
  });
});
