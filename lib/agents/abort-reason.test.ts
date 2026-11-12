import { describe, expect, it } from "vitest";
import { classifyAbortReason, resolveAbortClassification } from "./abort-reason";

describe("classifyAbortReason", () => {
  it("attributes the Stop-button reason to the user", () => {
    expect(classifyAbortReason("user_interrupted")).toMatchObject({
      actor: "user",
      code: "user_interrupted",
    });
  });

  it("keeps free-form user reasons from the soft-reset route on the user", () => {
    expect(classifyAbortReason("user clicked Abort in Settings").actor).toBe("user");
  });

  it("names the automatic cause for a graceful restart", () => {
    const out = classifyAbortReason("server_shutdown");
    expect(out.actor).toBe("system");
    expect(out.code).toBe("server_shutdown");
    expect(out.detail).toContain("shut down or restarted");
  });

  it("treats an unreported abort as a system cancellation", () => {
    expect(classifyAbortReason(undefined)).toMatchObject({ actor: "system", code: "unknown" });
    expect(classifyAbortReason("   ").actor).toBe("system");
  });

  it("keeps a custom system reason readable but bounded", () => {
    const out = classifyAbortReason("x".repeat(200));
    expect(out.actor).toBe("system");
    expect(out.code).toHaveLength(80);
    expect(out.detail).toContain("stopped automatically");
  });
});

describe("resolveAbortClassification", () => {
  it("prefers the reason the stream recorded at abort time", () => {
    const controller = new AbortController();
    controller.abort("server_shutdown");
    expect(resolveAbortClassification({ abortReason: "user_interrupted" }, controller.signal).actor)
      .toBe("user");
  });

  it("falls back to the controller reason when the chunk carried none", () => {
    const controller = new AbortController();
    controller.abort("server_shutdown");
    expect(resolveAbortClassification({}, controller.signal)).toMatchObject({
      actor: "system",
      code: "server_shutdown",
    });
  });
});
