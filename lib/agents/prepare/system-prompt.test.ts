import { describe, expect, it } from "vitest";
import { buildInboundChannelContext } from "./system-prompt";

describe("buildInboundChannelContext (ADR-0061)", () => {
  it("returns empty for plain chat (null category)", () => {
    expect(buildInboundChannelContext(null, false)).toBe("");
    expect(buildInboundChannelContext(null, true)).toBe("");
  });

  it("returns empty for unknown / forward-compat categories", () => {
    expect(buildInboundChannelContext("delegation", false)).toBe("");
    expect(buildInboundChannelContext("synthetic", false)).toBe("");
    expect(buildInboundChannelContext("future_kind", false)).toBe("");
  });

  it("renders the bridge cue with envelope shape and sender-role guidance", () => {
    const out = buildInboundChannelContext("bridge", false);
    expect(out).toContain("--- Active turn channel ---");
    expect(out).toContain("**bridge**");
    expect(out).toContain("[bridge:");
    expect(out).toContain("[message_role:");
    expect(out).toContain("active request");
  });

  it("renders the watcher cue with diff/directive framing", () => {
    const out = buildInboundChannelContext("watcher", false);
    expect(out).toContain("--- Active turn channel ---");
    expect(out).toContain("**watcher**");
    expect(out).toContain("diff");
    expect(out).toContain("directive");
    expect(out).toContain("active turn");
  });

  it("renders the scheduled_task cue without NO_REPLY when not silent", () => {
    const out = buildInboundChannelContext("scheduled_task", false);
    expect(out).toContain("--- Active turn channel ---");
    expect(out).toContain("**scheduled task**");
    expect(out).toContain("active turn");
    expect(out).not.toContain("NO_REPLY");
  });

  it("renders the scheduled_task cue WITH NO_REPLY when silent", () => {
    const out = buildInboundChannelContext("scheduled_task", true);
    expect(out).toContain("--- Active turn channel ---");
    expect(out).toContain("**scheduled task**");
    expect(out).toContain("**silent**");
    expect(out).toContain("NO_REPLY");
    // Guard: must NOT instruct skipping work — the cue should ask the
    // agent to run first, decide afterward.
    expect(out).toContain("run the task first");
  });

  it("silent flag is ignored on non-silent-aware categories", () => {
    // Bridge/watcher silent semantics live in the bridge body's role-note,
    // not in the system-prompt cue. Toggling silent here should not change
    // the cue text — keeps the cue stable across route flag changes.
    expect(buildInboundChannelContext("bridge", false)).toBe(
      buildInboundChannelContext("bridge", true),
    );
    expect(buildInboundChannelContext("watcher", false)).toBe(
      buildInboundChannelContext("watcher", true),
    );
  });
});
