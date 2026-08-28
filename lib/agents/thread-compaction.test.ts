import { describe, expect, it } from "vitest";

import { autoCompactionKeepLast } from "./thread-compaction";

describe("autoCompactionKeepLast", () => {
  it("leaves headroom below the configured retention cap", () => {
    expect(autoCompactionKeepLast(1000)).toBe(900);
    expect(autoCompactionKeepLast(50)).toBe(30);
  });

  it("keeps at least one message for tiny caps", () => {
    expect(autoCompactionKeepLast(1)).toBe(1);
    expect(autoCompactionKeepLast(10)).toBe(1);
  });
});