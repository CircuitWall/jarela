import { describe, it, expect } from "vitest";
import { computeDataQuality } from "./dashboard-metrics";

describe("computeDataQuality", () => {
  it("treats empty windows as fully measured to avoid a misleading red chip", () => {
    expect(computeDataQuality(0, 0)).toEqual({
      measured_messages: 0,
      estimated_messages: 0,
      measured_pct: 1,
    });
  });

  it("reports the measured ratio for mixed windows", () => {
    expect(computeDataQuality(9, 1)).toEqual({
      measured_messages: 9,
      estimated_messages: 1,
      measured_pct: 0.9,
    });
  });

  it("rounds to four decimals", () => {
    const q = computeDataQuality(1, 2);
    expect(q.measured_pct).toBe(0.3333);
  });

  it("reports 0% when every row is a legacy estimate", () => {
    expect(computeDataQuality(0, 7)).toEqual({
      measured_messages: 0,
      estimated_messages: 7,
      measured_pct: 0,
    });
  });
});
