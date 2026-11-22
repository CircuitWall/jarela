import { describe, expect, it } from "vitest";
import { computeRms, createSilenceDetector } from "./silence";

const opts = {
  pauseAfterMs: 600,
  endAfterMs: 1_200,
  noSpeechMs: 10_000,
  maxCaptureMs: 120_000,
  speechThreshold: 0.02,
  speechStartMs: 200,
};

function loud(): number {
  return 0.2;
}
function quiet(): number {
  return 0.001;
}

/** Feed timestamped samples and collect every event. */
function run(detector: ReturnType<typeof createSilenceDetector>, samples: Array<[number, number]>, startAt = 0) {
  const events: string[] = [];
  let t = startAt;
  for (const [rms, at] of samples) {
    t = at;
    events.push(...detector.sample(rms, t));
  }
  return { events, at: t };
}

describe("createSilenceDetector", () => {
  it("requires sustained speech before starting the turn", () => {
    const d = createSilenceDetector(0, opts);
    expect(d.sample(loud(), 100)).toEqual([]);
    expect(d.sample(loud(), 200)).toEqual(["speech-start"]);
    expect(d.phase).toBe("speaking");
  });

  it("pauses after the short silence and ends after the long silence", () => {
    const d = createSilenceDetector(0, opts);
    run(d, [[loud(), 100], [loud(), 200]]);
    expect(d.sample(quiet(), 500)).toEqual([]);
    expect(d.sample(quiet(), 800)).toEqual(["pause"]);
    expect(d.phase).toBe("paused");
    expect(d.sample(quiet(), 1_300)).toEqual([]);
    expect(d.sample(quiet(), 1_400)).toEqual(["end"]);
    expect(d.phase).toBe("ended");
  });

  it("resumes when speech returns during the pause window", () => {
    const d = createSilenceDetector(0, opts);
    run(d, [[loud(), 100], [loud(), 200]]);
    d.sample(quiet(), 800);
    const resumed = d.sample(loud(), 900);
    expect(resumed).toEqual(["resume"]);
    expect(d.phase).toBe("speaking");
    expect(d.sample(loud(), 1_000)).toEqual([]);
  });

  it("reports no speech when the user never starts talking", () => {
    const d = createSilenceDetector(0, opts);
    expect(d.sample(quiet(), 9_900)).toEqual([]);
    expect(d.sample(quiet(), 10_000)).toEqual(["no-speech"]);
    expect(d.phase).toBe("ended");
  });

  it("ends at the hard capture cap", () => {
    const d = createSilenceDetector(0, opts);
    run(d, [[loud(), 100], [loud(), 200]]);
    expect(d.sample(loud(), 120_000)).toEqual(["end"]);
  });

  it("skips the pause phase when pausing is disabled", () => {
    const d = createSilenceDetector(0, { ...opts, pauseAfterMs: 0 });
    run(d, [[loud(), 100], [loud(), 200]]);
    expect(d.sample(quiet(), 700)).toEqual([]);
    expect(d.sample(quiet(), 1_400)).toEqual(["end"]);
  });

  it("is inert after ending", () => {
    const d = createSilenceDetector(0, opts);
    run(d, [[loud(), 100], [loud(), 200]]);
    d.sample(quiet(), 1_400);
    expect(d.sample(loud(), 2_000)).toEqual([]);
  });
});

describe("computeRms", () => {
  it("is zero for a centred silent buffer", () => {
    expect(computeRms(new Uint8Array(64).fill(128))).toBe(0);
  });

  it("grows with amplitude", () => {
    const quietBuffer = new Uint8Array(64).fill(130);
    const loudBuffer = new Uint8Array(64).fill(200);
    expect(computeRms(loudBuffer)).toBeGreaterThan(computeRms(quietBuffer));
    expect(computeRms(loudBuffer)).toBeGreaterThan(0.5);
  });

  it("handles empty input", () => {
    expect(computeRms([])).toBe(0);
  });
});
