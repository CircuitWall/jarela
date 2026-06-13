import { describe, it, expect } from "vitest";
import { listManifests, getManifest } from "./registry";

describe("integration registry", () => {
  it("loads + validates every shipped manifest", () => {
    expect(listManifests().length).toBeGreaterThan(0);
    for (const m of listManifests()) {
      expect(m.id).toBeTruthy();
      expect(m.steps.length).toBeGreaterThan(0);
    }
  });

  it("getManifest looks up by id", () => {
    const id = listManifests()[0].id;
    expect(getManifest(id)?.id).toBe(id);
  });

  it("getManifest returns null for unknown id", () => {
    expect(getManifest("does-not-exist")).toBeNull();
  });

  it("listManifests returns a fresh array each call (callers can't mutate the cache)", () => {
    const a = listManifests();
    a.push({} as never);
    expect(listManifests().length).toBeLessThan(a.length);
  });
});
