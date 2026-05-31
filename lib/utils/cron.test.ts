import { describe, expect, it } from "vitest";
import { humanizeCron } from "./cron";

describe("humanizeCron", () => {
  it("returns null for empty or malformed input", () => {
    expect(humanizeCron("")).toBeNull();
    expect(humanizeCron("   ")).toBeNull();
    expect(humanizeCron("* * *")).toBeNull();
    expect(humanizeCron("* * * * * *")).toBeNull();
  });

  it("handles every-minute and every-N-minutes", () => {
    expect(humanizeCron("* * * * *")).toBe("every minute");
    expect(humanizeCron("*/5 * * * *")).toBe("every 5 minutes");
  });

  it("handles hourly at :MM", () => {
    expect(humanizeCron("15 * * * *")).toBe("hourly at :15");
    expect(humanizeCron("0 * * * *")).toBe("hourly at :00");
  });

  it("handles every-N-hours at :MM", () => {
    expect(humanizeCron("30 */6 * * *")).toBe("every 6 hours at :30");
  });

  it("handles daily at HH:MM", () => {
    expect(humanizeCron("0 9 * * *")).toBe("daily at 09:00");
    expect(humanizeCron("45 17 * * *")).toBe("daily at 17:45");
  });

  it("handles weekdays / weekends / single day / multi-day", () => {
    expect(humanizeCron("0 9 * * 1-5")).toBe("weekdays at 09:00");
    expect(humanizeCron("0 10 * * 0,6")).toBe("weekends at 10:00");
    expect(humanizeCron("0 10 * * 6,0")).toBe("weekends at 10:00");
    expect(humanizeCron("0 8 * * 3")).toBe("Wed at 08:00");
    expect(humanizeCron("0 8 * * 1,3,5")).toBe("Mon/Wed/Fri at 08:00");
  });

  it("handles monthly on day N at HH:MM", () => {
    expect(humanizeCron("0 0 1 * *")).toBe("monthly on day 1 at 00:00");
  });

  it("returns null for unsupported / exotic patterns", () => {
    expect(humanizeCron("0 9 1-15 * *")).toBeNull();
    expect(humanizeCron("0 9 * 1,6 *")).toBeNull();
    expect(humanizeCron("foo bar baz qux quux")).toBeNull();
    expect(humanizeCron("0 8 * * 9")).toBeNull();
  });
});
