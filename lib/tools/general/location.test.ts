import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const profileMock = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));

vi.mock("@/lib/stores/user-profile", () => ({
  getUserProfile: () => profileMock.value,
}));

import { getUserLocationTool } from "./location";

async function invoke(args: unknown = {}) {
  return JSON.parse(String(await getUserLocationTool.invoke(args as Record<string, never>)));
}

describe("get_user_location as used by an agent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    profileMock.value = null;
  });

  it("explains how to enable sharing when no profile exists", async () => {
    profileMock.value = null;
    expect(await invoke()).toMatchObject({ available: false, reason: "user has not enabled location sharing" });
  });

  it("withholds coordinates when consent is revoked even if old coordinates remain", async () => {
    profileMock.value = { location_consent: 0, location_lat: 51.5, location_lng: -0.12 };
    const result = await invoke();
    expect(result.available).toBe(false);
    expect(result).not.toHaveProperty("lat");
    expect(result).not.toHaveProperty("lng");
  });

  it("reports missing coordinates after consent", async () => {
    profileMock.value = { location_consent: 1, location_lat: null, location_lng: null };
    expect(await invoke()).toMatchObject({ available: false, reason: "consent granted but no coordinates reported yet" });
  });

  it.each([
    [Number.NaN, 0],
    [0, Number.POSITIVE_INFINITY],
    [91, 0],
    [0, -181],
  ])("does not report invalid coordinates (%s, %s) as available", async (lat, lng) => {
    profileMock.value = { location_consent: 1, location_lat: lat, location_lng: lng };
    const result = await invoke();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/invalid/i);
    expect(result).not.toHaveProperty("lat");
  });

  it("returns a fresh fix with its age", async () => {
    profileMock.value = {
      location_consent: 1,
      location_lat: 51.5,
      location_lng: -0.12,
      location_accuracy_m: 25,
      location_label: "Home",
      location_updated_at: "2026-01-10T11:59:00.000Z",
    };
    expect(await invoke()).toEqual({
      available: true,
      lat: 51.5,
      lng: -0.12,
      accuracy_m: 25,
      label: "Home",
      updated_at: "2026-01-10T11:59:00.000Z",
      age_seconds: 60,
    });
  });

  it("keeps the location but leaves age unknown for an unparseable timestamp", async () => {
    profileMock.value = { location_consent: 1, location_lat: 1, location_lng: 2, location_updated_at: "not a date" };
    const result = await invoke();
    expect(result.available).toBe(true);
    expect(result.age_seconds).toBeNull();
  });

  it("does not report a negative age for a timestamp ahead of the server clock", async () => {
    profileMock.value = { location_consent: 1, location_lat: 1, location_lng: 2, location_updated_at: "2026-01-10T12:05:00.000Z" };
    expect((await invoke()).age_seconds).toBe(0);
  });

  it("ignores unexpected arguments from the agent", async () => {
    profileMock.value = { location_consent: 1, location_lat: 1, location_lng: 2 };
    expect((await invoke({ precise: true })).available).toBe(true);
  });
});
