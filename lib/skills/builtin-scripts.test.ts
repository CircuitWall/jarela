import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePersonalBriefing } from "./builtins/personal-briefing/scripts/validate.mjs";
import { planMemoryCleanup } from "./builtins/memory-organization/scripts/plan-cleanup.mjs";
import { loadSkillFixtures } from "./fixtures";
import { validatePersonalBriefingTool } from "@/lib/tools/general/validate-personal-briefing";
import { planMemoryCleanupTool } from "@/lib/tools/general/plan-memory-cleanup";
import { registeredCapability } from "@/lib/tools/runtime/registry";

const root = mkdtempSync(join(tmpdir(), "jarela-portable-builtins-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const name of ["personal-briefing", "memory-organization"]) {
  cpSync(join(process.cwd(), "lib", "skills", "builtins", name), join(root, name), { recursive: true });
}
const run = (name: string, input: string | Buffer) => spawnSync(
  process.execPath, [join(root, name, "scripts", "run.mjs")],
  { input, cwd: tmpdir(), encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, env: {} },
);
const entry = (key: string, overrides = {}) => ({
  key, kind: "fact", subject: "Project", content: "Use deterministic checks.",
  status: "active", expires_at: null, ...overrides,
});
const valid = () => ({
  now: "2026-10-29T00:00:00Z",
  entries: [entry("b"), entry("a"), entry("expired", { expires_at: "2026-10-29T00:00:00Z" })],
});

describe("portable built-in script contracts", () => {
  it.each(loadSkillFixtures(join(process.cwd(), "lib", "skills", "builtins", "personal-briefing")))(
    "runs briefing fixture $name outside Jarela and matches the typed tool exactly",
    async (fixture) => {
      const child = run("personal-briefing", JSON.stringify(fixture.input));
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(fixture.expect.ok ? 0 : 1);
      expect(child.stderr).toBe("");
      const result = JSON.parse(child.stdout);
      expect(result).toEqual(validatePersonalBriefing(fixture.input));
      expect(result).toEqual(JSON.parse(String(await validatePersonalBriefingTool.invoke(
        validatePersonalBriefingTool.schema.parse(fixture.input),
      ))));
      expect(result.ok).toBe(fixture.expect.ok);
    },
  );

  it("uses the same read-only memory planner through the portable CLI and typed tool", async () => {
    const child = run("memory-organization", JSON.stringify(valid()));
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    const result = JSON.parse(child.stdout);
    expect(result).toEqual(planMemoryCleanup(valid()));
    expect(result).toEqual(JSON.parse(String(await planMemoryCleanupTool.invoke(
      planMemoryCleanupTool.schema.parse(valid()),
    ))));
    expect(result).toMatchObject({ ok: true, duplicate_groups: [["a", "b"]], expired_keys: ["expired"] });
    expect(registeredCapability("plan_memory_cleanup")).toBe("read");
  });

  it.each(loadSkillFixtures(join(process.cwd(), "lib", "skills", "builtins", "memory-organization")))(
    "runs cleanup fixture $name outside Jarela and matches the typed tool",
    async (fixture) => {
      const child = run("memory-organization", JSON.stringify(fixture.input));
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(fixture.expect.ok ? 0 : 1);
      expect(child.stderr).toBe("");
      expect(JSON.parse(child.stdout)).toEqual(JSON.parse(String(await planMemoryCleanupTool.invoke(
        planMemoryCleanupTool.schema.parse(fixture.input),
      ))));
    },
  );

  it.each(["personal-briefing", "memory-organization"])("rejects malformed, oversized and invalid UTF-8 CLI input for %s", (name) => {
    for (const input of ["{", '{"private-value": unexpected}', " ".repeat(65537), Buffer.from([0xff])]) {
      const child = run(name, input);
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      expect(child.stdout).toBe("");
      expect(child.stderr).toContain("input failed:");
      expect(child.stderr).not.toContain("private-value");
    }
    const invalid = run(name, "null");
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ ok: false, issues: expect.any(Array) });
  });

  it("accepts exactly 64 KiB of input and rejects one additional byte", () => {
    const json = JSON.stringify({ now: valid().now, entries: [] });
    const exact = json + " ".repeat(65536 - Buffer.byteLength(json));
    expect(run("memory-organization", exact).status).toBe(0);
    const oversized = run("memory-organization", exact + " ");
    expect(oversized.status).toBe(1);
    expect(oversized.stderr).toContain("exceeds 64 KiB");
  });

  it("does not mutate inputs, merge semantic near-matches, or include archived/expired duplicate candidates", () => {
    const input = {
      now: valid().now,
      entries: [
        entry("same-a"), entry("same-b"),
        entry("different-case", { content: "use deterministic checks." }),
        entry("different-subject", { subject: "Other project" }),
        entry("different-kind", { kind: "preference" }),
        entry("different-expiry", { expires_at: "2027-01-01T00:00:00Z" }),
        entry("archived", { status: "archived" }),
        entry("expired", { expires_at: "2020-01-01T00:00:00Z" }),
      ],
    };
    const before = structuredClone(input);
    expect(planMemoryCleanup(input)).toMatchObject({
      ok: true, duplicate_groups: [["same-a", "same-b"]], expired_keys: ["expired"],
    });
    expect(input).toEqual(before);
    expect(planMemoryCleanup({ ...input, entries: [...input.entries].reverse() })).toEqual(planMemoryCleanup(input));
  });

  it.each([
    null,
    { ...valid(), now: "yesterday" },
    { ...valid(), now: "2026-02-30T00:00:00Z" },
    { ...valid(), now: "2026-10-29T00:00:00+01:00" },
    { ...valid(), entries: [entry("same"), entry("same")] },
    { ...valid(), entries: [entry(" "), entry("a")] },
    { ...valid(), entries: [entry("a", { expires_at: "2026-02-30T00:00:00Z" })] },
    { ...valid(), entries: [entry("a", { status: "unknown" })] },
    { ...valid(), entries: Array.from({ length: 101 }, (_, index) => entry(String(index))) },
  ])("rejects invalid cleanup input explicitly", (input) => {
    expect(planMemoryCleanup(input)).toMatchObject({ ok: false, issues: expect.any(Array) });
  });

  it("allows empty cleanup input and compares timestamp instants, including fractions", () => {
    expect(planMemoryCleanup({ now: valid().now, entries: [] })).toMatchObject({
      ok: true, expired_keys: [], duplicate_groups: [],
    });
    expect(planMemoryCleanup({
      now: "2026-10-29T00:00:00.500Z",
      entries: [entry("earlier", { expires_at: "2026-10-29T00:00:00.499Z" }), entry("later", { expires_at: "2026-10-29T00:00:00.501Z" })],
    })).toMatchObject({ ok: true, expired_keys: ["earlier"] });
  });

  it("rejects sparse arrays rather than silently accepting missing elements", () => {
    expect(planMemoryCleanup({ now: valid().now, entries: new Array(1) })).toMatchObject({ ok: false });
    expect(validatePersonalBriefing({
      sources: new Array(1), briefing: { items: [], unavailable_source_ids: [] },
    })).toMatchObject({ ok: false });
  });

  it("preserves briefing trimming and unknown-field stripping through the extracted implementation", async () => {
    const input = {
      extra: "ignored",
      sources: [{ id: " one ", available: true, extra: "ignored" }],
      briefing: { items: [{ text: " Summary ", source_ids: [" one "], extra: "ignored" }], unavailable_source_ids: [], extra: "ignored" },
    };
    const result = validatePersonalBriefing(input);
    expect(result).toMatchObject({
      ok: true, briefing: { items: [{ text: "Summary", source_ids: ["one"] }], unavailable_source_ids: [] },
    });
    expect(result).toEqual(JSON.parse(String(await validatePersonalBriefingTool.invoke(
      validatePersonalBriefingTool.schema.parse(input),
    ))));
  });

  it("keeps portable briefing shape bounds aligned with the provider-facing schema", () => {
    const draft = {
      sources: [{ id: "one", available: true }],
      briefing: { items: [{ text: "Summary", source_ids: ["one"] }], unavailable_source_ids: [] },
    };
    const candidates = [
      draft,
      { ...draft, sources: Array.from({ length: 100 }, (_, index) => ({ id: String(index), available: false })),
        briefing: { items: [], unavailable_source_ids: Array.from({ length: 100 }, (_, index) => String(index)) } },
      { ...draft, sources: Array.from({ length: 101 }, (_, index) => ({ id: String(index), available: true })) },
      { ...draft, sources: [{ id: "x".repeat(201), available: true }] },
      { ...draft, briefing: { items: [{ text: "x".repeat(2001), source_ids: ["one"] }], unavailable_source_ids: [] } },
      { ...draft, briefing: { items: Array.from({ length: 41 }, () => draft.briefing.items[0]), unavailable_source_ids: [] } },
      { ...draft, briefing: { items: [{ text: "Summary", source_ids: [] }], unavailable_source_ids: [] } },
      { ...draft, briefing: { items: [], unavailable_source_ids: Array.from({ length: 101 }, () => "one") } },
    ];
    for (const candidate of candidates) {
      expect(validatePersonalBriefing(candidate).ok).toBe(validatePersonalBriefingTool.schema.safeParse(candidate).success);
    }
  });
});
