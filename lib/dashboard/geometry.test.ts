import { describe, expect, it } from "vitest";
import { arcPath } from "./geometry";

describe("arcPath", () => {
  it("returns empty string when end angle is not greater than start", () => {
    expect(arcPath(0, 0, 10, 1, 1)).toBe("");
    expect(arcPath(0, 0, 10, 2, 1)).toBe("");
  });

  it("emits a small-arc when sweep is <= PI", () => {
    const path = arcPath(0, 0, 10, 0, Math.PI / 2);
    // Format: M x1 y1 A r r 0 largeArc 1 x2 y2
    const match = path.match(/^M (\S+) (\S+) A 10 10 0 (\d) 1 (\S+) (\S+)$/);
    expect(match).not.toBeNull();
    expect(match![3]).toBe("0");
    // start at angle 0 -> (10, 0)
    expect(Number(match![1])).toBeCloseTo(10, 5);
    expect(Number(match![2])).toBeCloseTo(0, 5);
    // end at angle PI/2 -> (~0, 10)
    expect(Number(match![4])).toBeCloseTo(0, 5);
    expect(Number(match![5])).toBeCloseTo(10, 5);
  });

  it("toggles large-arc flag when sweep > PI", () => {
    const path = arcPath(0, 0, 10, 0, Math.PI + 0.001);
    expect(path.match(/A 10 10 0 (\d) 1/)![1]).toBe("1");
  });

  it("does not toggle large-arc flag at exactly PI", () => {
    const path = arcPath(0, 0, 10, 0, Math.PI);
    expect(path.match(/A 10 10 0 (\d) 1/)![1]).toBe("0");
  });

  it("respects center offset", () => {
    const path = arcPath(50, 50, 10, 0, Math.PI / 2);
    const match = path.match(/^M (\S+) (\S+) A 10 10 0 \d 1 (\S+) (\S+)$/)!;
    expect(Number(match[1])).toBeCloseTo(60, 5);
    expect(Number(match[2])).toBeCloseTo(50, 5);
    expect(Number(match[3])).toBeCloseTo(50, 5);
    expect(Number(match[4])).toBeCloseTo(60, 5);
  });
});
