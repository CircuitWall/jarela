import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import {
  SkillRunConsent, skillInvocationDigest, SKILL_CONSENT_TTL_MS, SKILL_CONSENT_MAX_PROPOSALS, type SkillConsentBinding,
} from "./execution-consent";

const scope = () => ({ agentId: "test-agent", runId: "test-run", workspace: resolve("test-workspace") });
const binding = (): SkillConsentBinding => ({
  ...scope(), artifactRevision: "a".repeat(64), inputDigest: skillInvocationDigest('{"message":"hello"}'),
  runtimeVersion: process.version, timeoutMs: 60_000, maxOutputBytes: 65_536,
});
const policy = { executeAllowed: true, safeMode: false };
const runs: SkillRunConsent[] = [];
function run(controller = new AbortController()) {
  const consent = new SkillRunConsent(scope(), controller.signal);
  runs.push(consent);
  return consent;
}
afterEach(() => {
  for (const consent of runs.splice(0)) consent.close();
  vi.useRealTimers();
});

describe("run-scoped skill consent", () => {
  it("binds immutable data without retaining invocation text", () => {
    const consent = run();
    const original = { ...binding() };
    const proposal = consent.propose(original);
    original.artifactRevision = "b".repeat(64);
    expect(proposal.binding.artifactRevision).toBe("a".repeat(64));
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(Object.isFrozen(proposal.binding)).toBe(true);
    expect(JSON.stringify(proposal)).not.toContain("hello");
    consent.decide(proposal.id, "approve");
    expect(consent.consume(proposal.id, binding(), policy)).toEqual(binding());
    expect(consent.inspect(proposal.id).status).toBe("consumed");
    expect(() => consent.consume(proposal.id, binding(), policy)).toThrow(/consumed/);
  });

  it.each(["pending", "denied"] as const)("cannot consume %s consent", (status) => {
    const consent = run();
    const proposal = consent.propose(binding());
    if (status === "denied") consent.decide(proposal.id, "deny");
    expect(() => consent.consume(proposal.id, binding(), policy)).toThrow(status);
  });

  it.each(["approve", "deny"] as const)("rejects duplicate or conflicting decision %s", (decision) => {
    const consent = run();
    const proposal = consent.propose(binding());
    consent.decide(proposal.id, decision);
    expect(() => consent.decide(proposal.id, "approve")).toThrow(/decision rejected/);
    expect(() => consent.decide(proposal.id, "deny")).toThrow(/decision rejected/);
  });

  it.each([
    { agentId: "other-agent" }, { runId: "other-run" }, { workspace: resolve("other-workspace") },
    { artifactRevision: "b".repeat(64) }, { inputDigest: skillInvocationDigest('{"message":"changed"}') },
    { runtimeVersion: `${process.version}-different` }, { timeoutMs: 1000 }, { maxOutputBytes: 1 },
    { artifactRevision: "invalid" },
  ])("invalidates consent when any bound field changes: %j", (change) => {
    const consent = run();
    const proposal = consent.propose(binding());
    consent.decide(proposal.id, "approve");
    expect(() => consent.consume(proposal.id, { ...binding(), ...change }, policy)).toThrow(/binding changed/);
    expect(consent.inspect(proposal.id).status).toBe("stale");
    expect(() => consent.consume(proposal.id, binding(), policy)).toThrow(/stale/);
  });

  it.each([
    { executeAllowed: false, safeMode: false }, { executeAllowed: true, safeMode: true },
  ])("invalidates consent when current policy rejects execution: %j", (currentPolicy) => {
    const consent = run();
    const proposal = consent.propose(binding());
    consent.decide(proposal.id, "approve");
    expect(() => consent.consume(proposal.id, binding(), currentPolicy)).toThrow(/execute capability/);
    expect(consent.inspect(proposal.id).status).toBe("cancelled");
  });

  it.each(["pending", "approved"] as const)("expires %s consent at the exact deadline", (status) => {
    vi.useFakeTimers();
    const consent = run();
    const proposal = consent.propose(binding());
    if (status === "approved") consent.decide(proposal.id, "approve");
    vi.advanceTimersByTime(SKILL_CONSENT_TTL_MS - 1);
    expect(consent.inspect(proposal.id).status).toBe(status);
    vi.advanceTimersByTime(1);
    expect(consent.inspect(proposal.id).status).toBe("expired");
    expect(() => consent.decide(proposal.id, "approve")).toThrow(/expired/);
    expect(() => consent.consume(proposal.id, binding(), policy)).toThrow(/expired/);
  });

  it.each(["pending", "approved"] as const)("cancels %s consent on abort and unregisters its listener", (status) => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const consent = run(controller);
    const proposal = consent.propose(binding());
    if (status === "approved") consent.decide(proposal.id, "approve");
    controller.abort();
    expect(consent.inspect(proposal.id).status).toBe("cancelled");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(() => consent.consume(proposal.id, binding(), policy)).toThrow(/closed/);
    expect(() => consent.decide(proposal.id, "approve")).toThrow(/closed/);
    expect(() => consent.propose(binding())).toThrow(/closed/);
  });

  it("rejects a run already aborted before construction", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => run(controller).propose(binding())).toThrow(/closed/);
  });

  it("cannot reuse consent in another instance or after run completion", () => {
    const first = run();
    const proposal = first.propose(binding());
    first.decide(proposal.id, "approve");
    expect(() => run().consume(proposal.id, binding(), policy)).toThrow(/instance/);
    first.close();
    first.close();
    expect(first.inspect(proposal.id).status).toBe("cancelled");
    expect(() => first.consume(proposal.id, binding(), policy)).toThrow(/closed/);
  });

  it("stales earlier proposals, even when re-proposing identical bindings", () => {
    const consent = run();
    const old = consent.propose(binding());
    consent.decide(old.id, "approve");
    const next = consent.propose(binding());
    expect(next.id).not.toBe(old.id);
    expect(consent.inspect(old.id).status).toBe("stale");
    expect(() => consent.consume(old.id, binding(), policy)).toThrow(/stale/);
    expect(consent.inspect(next.id).status).toBe("pending");
  });

  it("rejects invalid proposals without invalidating the current proposal", () => {
    const consent = run();
    const current = consent.propose(binding());
    expect(() => consent.propose({ ...binding(), runId: "other" })).toThrow(/this run/);
    expect(() => consent.propose({ ...binding(), timeoutMs: 999 })).toThrow();
    expect(consent.inspect(current.id).status).toBe("pending");
  });

  it("copies the run scope and rejects unknown IDs", () => {
    const original = scope();
    const consent = new SkillRunConsent(original, new AbortController().signal);
    runs.push(consent);
    original.runId = "changed";
    expect(consent.propose(binding()).binding.runId).toBe("test-run");
    expect(() => consent.inspect("unknown")).toThrow(/this run instance/);
    expect(() => consent.decide("unknown", "approve")).toThrow(/this run instance/);
    expect(() => consent.consume("unknown", binding(), policy)).toThrow(/this run instance/);
  });

  it("does not undo a consumed grant when the run closes", () => {
    const consent = run();
    const proposal = consent.propose(binding());
    consent.decide(proposal.id, "approve");
    consent.consume(proposal.id, binding(), policy);
    consent.close();
    expect(consent.inspect(proposal.id).status).toBe("consumed");
  });

  it("allows exactly one synchronous claimant from concurrent callbacks", async () => {
    const consent = run();
    const proposal = consent.propose(binding());
    consent.decide(proposal.id, "approve");
    const results = await Promise.allSettled(Array.from({ length: 10 }, async () =>
      consent.consume(proposal.id, binding(), policy)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(9);
  });

  it("rejects relative workspace identities", () => {
    expect(() => new SkillRunConsent({ ...scope(), workspace: "relative" }, new AbortController().signal))
      .toThrow(/absolute resolved path/);
  });

  it("bounds retained proposal metadata without silently evicting decisions", () => {
    const consent = run();
    for (let i = 0; i < SKILL_CONSENT_MAX_PROPOSALS; i++) consent.propose(binding());
    expect(() => consent.propose(binding())).toThrow(/proposal limit/);
  });

  it("does not extend the consent lifetime when the wall clock moves backwards", () => {
    vi.useFakeTimers();
    const consent = run();
    const proposal = consent.propose(binding());
    consent.decide(proposal.id, "approve");
    vi.setSystemTime(Date.now() - 60 * 60 * 1000);
    vi.advanceTimersByTime(SKILL_CONSENT_TTL_MS);
    expect(consent.inspect(proposal.id).status).toBe("expired");
  });
});

describe("skill invocation identity", () => {
  it("hashes exact bytes, retaining whitespace and metacharacters as data", () => {
    expect(skillInvocationDigest('{"text":"$(echo no); & >"}')).toMatch(/^[a-f0-9]{64}$/);
    expect(skillInvocationDigest("{}")).not.toBe(skillInvocationDigest("{ }"));
    expect(skillInvocationDigest('{"a":1,"b":2}')).not.toBe(skillInvocationDigest('{"b":2,"a":1}'));
  });

  it.each(["", "{", "null", "[]", "true", '"text"'])("rejects malformed or non-object input %j", (text) => {
    expect(() => skillInvocationDigest(text)).toThrow();
  });

  it("checks the exact UTF-8 byte limit", () => {
    expect(skillInvocationDigest("{}".padEnd(64 * 1024))).toMatch(/^[a-f0-9]{64}$/);
    expect(() => skillInvocationDigest("{}".padEnd(64 * 1024 + 1))).toThrow(/64 KiB/);
    expect(() => skillInvocationDigest(JSON.stringify({ value: "é".repeat(32 * 1024) }))).toThrow(/64 KiB/);
  });

  it("checks nesting and node bounds before hashing", () => {
    let value: unknown = {};
    for (let i = 0; i < 33; i++) value = { value };
    expect(() => skillInvocationDigest(JSON.stringify(value))).toThrow(/depth or node/);
    expect(() => skillInvocationDigest(JSON.stringify({ values: Array(4096).fill(null) }))).toThrow(/depth or node/);
  });

  it("rejects JSON numeric overflow instead of hashing non-finite arguments", () => {
    expect(() => skillInvocationDigest('{"value":1e400}')).toThrow(/finite numbers/);
  });
});
