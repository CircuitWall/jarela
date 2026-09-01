import { describe, expect, it } from "vitest";

import {
  BRIDGE_PROFILE,
  FOREGROUND_PROFILE,
  FULL_PROFILE,
  ONE_SHOT_PROFILE,
  TURN_PROFILES,
  resolveTurnProfile,
} from "./turn-profile";

describe("turn-profile", () => {
  it("assigns source-specific conversational profiles", () => {
    expect(TURN_PROFILES.user).toEqual(FOREGROUND_PROFILE);
    expect(TURN_PROFILES.bridge).toEqual(BRIDGE_PROFILE);
    expect(TURN_PROFILES.delegate).toEqual(FULL_PROFILE);
  });

  it("extension / scheduler / watcher / trigger get the one-shot profile", () => {
    expect(TURN_PROFILES.extension).toEqual(ONE_SHOT_PROFILE);
    expect(TURN_PROFILES.scheduler).toEqual(ONE_SHOT_PROFILE);
    expect(TURN_PROFILES.watcher).toEqual(ONE_SHOT_PROFILE);
    expect(TURN_PROFILES.trigger).toEqual(ONE_SHOT_PROFILE);
  });

  it("ONE_SHOT_PROFILE has every context source disabled", () => {
    expect(ONE_SHOT_PROFILE.include_facts).toBe(false);
    expect(ONE_SHOT_PROFILE.include_recall).toBe(false);
    expect(ONE_SHOT_PROFILE.include_hot).toBe(false);
    expect(ONE_SHOT_PROFILE.include_warm).toBe(false);
    expect(ONE_SHOT_PROFILE.history_scope).toBe("none");
  });

  it("resolveTurnProfile falls back to the full profile when source is missing", () => {
    expect(resolveTurnProfile(null)).toEqual(FULL_PROFILE);
    expect(resolveTurnProfile(undefined)).toEqual(FULL_PROFILE);
  });

  it("resolveTurnProfile maps source to its registered profile", () => {
    expect(resolveTurnProfile("extension")).toEqual(ONE_SHOT_PROFILE);
    expect(resolveTurnProfile("bridge")).toEqual(BRIDGE_PROFILE);
  });

  it("resolveTurnProfile applies partial overrides on top of the base", () => {
    expect(resolveTurnProfile("extension", { include_hot: true })).toEqual({
      ...ONE_SHOT_PROFILE,
      include_hot: true,
    });
    expect(resolveTurnProfile("user", { include_recall: false, include_facts: false })).toEqual({
      ...FOREGROUND_PROFILE,
      include_recall: false,
      include_facts: false,
    });
  });
});
