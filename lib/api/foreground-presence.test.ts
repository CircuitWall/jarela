import { afterEach, describe, expect, it } from "vitest";
import {
  FOREGROUND_PRESENCE_TTL_MS,
  clearForegroundTabPresence,
  getForegroundTabPresence,
  setForegroundTabPresence,
} from "./foreground-presence";
import { buildSurroundingsContext } from "@/lib/agents/prepare/system-prompt";

const sample = {
  url: "https://example.com/docs/setup",
  title: "Setup guide",
  host: "example.com",
  tab_id: 7,
  recorded_at: Date.now(),
};

afterEach(() => clearForegroundTabPresence());

describe("foreground tab presence", () => {
  it("returns nothing before anything is pushed", () => {
    expect(getForegroundTabPresence()).toBeNull();
  });

  it("round-trips the last push", () => {
    setForegroundTabPresence(sample);
    expect(getForegroundTabPresence()?.url).toBe(sample.url);
  });

  it("expires rather than reporting a stale page", () => {
    const stored = setForegroundTabPresence(sample);
    const justInside = stored.received_at + FOREGROUND_PRESENCE_TTL_MS;
    expect(getForegroundTabPresence(justInside)).not.toBeNull();
    expect(getForegroundTabPresence(justInside + 1)).toBeNull();
  });

  it("clears on retraction", () => {
    setForegroundTabPresence(sample);
    clearForegroundTabPresence();
    expect(getForegroundTabPresence()).toBeNull();
  });
});

describe("buildSurroundingsContext", () => {
  it("is empty without presence", () => {
    expect(buildSurroundingsContext(null)).toBe("");
  });

  it("names the page and frames it as context, not instruction", () => {
    const now = sample.recorded_at + 30_000;
    const out = buildSurroundingsContext({ ...sample, received_at: sample.recorded_at }, now);
    expect(out).toContain("--- Current surroundings ---");
    expect(out).toContain("Setup guide");
    expect(out).toContain("https://example.com/docs/setup");
    expect(out).toContain("30s ago");
    expect(out).toContain("not an instruction");
  });

  it("never carries page content", () => {
    const out = buildSurroundingsContext({ ...sample, received_at: sample.recorded_at });
    expect(out.length).toBeLessThan(600);
  });
});
