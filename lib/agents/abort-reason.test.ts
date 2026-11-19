import { describe, expect, it } from "vitest";
import {
  classifyAbortReason,
  encodeWatchdogReason,
  resolveAbortClassification,
  watchdogTermination,
} from "./abort-reason";

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

describe("watchdogTermination", () => {
  it("carries the watchdog's diagnostic into the persisted message", () => {
    const reason = encodeWatchdogReason("run_idle_timeout", {
      idleMs: 120_400,
      idleLimitMs: 120_000,
      phase: "starting",
      producedOutput: false,
      model: "deepseek/deepseek-v4-flash",
    });

    const out = watchdogTermination(reason);

    expect(out?.code).toBe("run_idle_timeout");
    expect(out?.message).toContain("120s of silence");
    expect(out?.message).toContain("never sent its first token");
    expect(out?.message).toContain("deepseek/deepseek-v4-flash");
    expect(out?.message).toContain("JARELA_RUN_IDLE_MS (currently 120s)");
    expect(out?.detail.producedOutput).toBe(false);
  });

  it("distinguishes a mid-reply stall from a first-token stall", () => {
    const out = watchdogTermination(encodeWatchdogReason("run_idle_timeout", {
      idleMs: 121_000,
      producedOutput: true,
    }));
    expect(out?.message).toContain("121s of silence");
    expect(out?.message).not.toContain("never sent its first token");
  });

  it("still maps a bare watchdog code", () => {
    expect(watchdogTermination("run_idle_timeout")?.code).toBe("run_idle_timeout");
    expect(watchdogTermination("run_watchdog_timeout")?.code).toBe("run_max_timeout");
    expect(watchdogTermination("server_shutdown")).toBeNull();
  });

  it("merges detail the aborting layer could not know", () => {
    const reason = encodeWatchdogReason("run_idle_timeout", { idleMs: 120_000 });
    const out = watchdogTermination(reason, { model: "deepseek/deepseek-v4-pro" });
    expect(out?.detail.idleMs).toBe(120_000);
    expect(out?.message).toContain("deepseek/deepseek-v4-pro");
  });

  it("survives a malformed detail suffix", () => {
    const out = watchdogTermination("run_idle_timeout|{not-json");
    expect(out?.code).toBe("run_idle_timeout");
    expect(out?.detail).toEqual({});
  });

  it("classifies an encoded watchdog reason as a system stop", () => {
    const reason = encodeWatchdogReason("run_idle_timeout", { idleMs: 1_000 });
    const out = classifyAbortReason(reason);
    expect(out.actor).toBe("system");
    expect(out.code).toBe("run_idle_timeout");
    expect(out.detail).toContain("stopped making progress");
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
