import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { loadSkillFixtures, runSkillFixture, type FixtureToolResolver } from "./fixtures";
import { getBuiltinSkillsDir } from "./index";
import { registeredCapability, registeredTools } from "@/lib/tools/runtime/registry";
import "@/lib/tools/general/validate-personal-briefing";

const echoValidator = tool(
  async (input: { value: number }) =>
    JSON.stringify(
      input.value > 0
        ? { ok: true }
        : { ok: false, issues: [{ path: "value", message: "must be positive" }] },
    ),
  { name: "fake_validator", description: "test", schema: z.object({ value: z.number() }) },
);
const writer = tool(async () => "sent", {
  name: "fake_send_email",
  description: "test",
  schema: z.object({}),
});

const fakeResolver: FixtureToolResolver = (name) => {
  if (name === "fake_validator") return { tool: echoValidator, capability: "read" };
  if (name === "fake_send_email") return { tool: writer, capability: "write" };
  return undefined;
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarela-skill-fixtures-"));
});
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

function writeFixture(name: string, body: unknown) {
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "tests", name), typeof body === "string" ? body : JSON.stringify(body));
}

describe("loadSkillFixtures", () => {
  it("returns no fixtures for a skill without a tests folder", () => {
    expect(loadSkillFixtures(dir)).toEqual([]);
  });

  it("names the file and field when a fixture is malformed", () => {
    writeFixture("broken.json", { name: "x", tool: "fake_validator", input: {} });
    expect(() => loadSkillFixtures(dir)).toThrow(/broken\.json.*expect/);
  });

  it("names the file when a fixture is not valid JSON", () => {
    writeFixture("bad.json", "{ not json");
    expect(() => loadSkillFixtures(dir)).toThrow(/bad\.json/);
  });

  it("ignores non-JSON files so skills can keep notes beside fixtures", () => {
    writeFixture("README.md", "notes");
    writeFixture("ok.json", { name: "ok", tool: "fake_validator", input: { value: 1 }, expect: { ok: true } });
    expect(loadSkillFixtures(dir).map((f) => f.name)).toEqual(["ok"]);
  });
});

describe("runSkillFixture", () => {
  it("passes when the tool outcome matches the expected verdict", async () => {
    const result = await runSkillFixture(
      { name: "positive", tool: "fake_validator", input: { value: 3 }, expect: { ok: true } },
      fakeResolver,
    );
    expect(result).toEqual({ name: "positive", passed: true });
  });

  it("requires every expected issue path to be reported", async () => {
    const pass = await runSkillFixture(
      { name: "neg", tool: "fake_validator", input: { value: -1 }, expect: { ok: false, issue_paths: ["value"] } },
      fakeResolver,
    );
    expect(pass.passed).toBe(true);
    const fail = await runSkillFixture(
      { name: "neg", tool: "fake_validator", input: { value: -1 }, expect: { ok: false, issue_paths: ["other"] } },
      fakeResolver,
    );
    expect(fail).toMatchObject({ passed: false, reason: expect.stringMatching(/other/) });
  });

  it("fails when the verdict differs", async () => {
    const result = await runSkillFixture(
      { name: "wrong", tool: "fake_validator", input: { value: -1 }, expect: { ok: true } },
      fakeResolver,
    );
    expect(result).toMatchObject({ passed: false, reason: expect.stringMatching(/expected ok=true/) });
  });

  it("never invokes a tool that is not read-only", async () => {
    let called = false;
    const resolver: FixtureToolResolver = (name) => {
      const resolved = fakeResolver(name);
      if (!resolved) return undefined;
      return {
        capability: resolved.capability,
        tool: { invoke: async (i: unknown) => { called = true; return resolved.tool.invoke(i as never); } },
      };
    };
    const result = await runSkillFixture(
      { name: "unsafe", tool: "fake_send_email", input: {}, expect: { ok: true } },
      resolver,
    );
    expect(called).toBe(false);
    expect(result).toMatchObject({ passed: false, reason: expect.stringMatching(/read-only/) });
  });

  it("fails clearly for an unknown tool", async () => {
    const result = await runSkillFixture(
      { name: "missing", tool: "nope", input: {}, expect: { ok: true } },
      fakeResolver,
    );
    expect(result).toMatchObject({ passed: false, reason: expect.stringMatching(/not registered/) });
  });

  it("fails clearly when the tool throws or returns non-JSON", async () => {
    const thrower = tool(async () => { throw new Error("boom"); }, { name: "t", description: "t", schema: z.object({}) });
    const plain = tool(async () => "plain text", { name: "p", description: "p", schema: z.object({}) });
    const resolver: FixtureToolResolver = (name) =>
      name === "t" ? { tool: thrower, capability: "read" } : { tool: plain, capability: "read" };
    expect(await runSkillFixture({ name: "a", tool: "t", input: {}, expect: { ok: true } }, resolver))
      .toMatchObject({ passed: false, reason: expect.stringMatching(/boom/) });
    expect(await runSkillFixture({ name: "b", tool: "p", input: {}, expect: { ok: true } }, resolver))
      .toMatchObject({ passed: false, reason: expect.stringMatching(/JSON/) });
  });
});

describe("built-in skill fixtures", () => {
  const registryResolver: FixtureToolResolver = (name) => {
    const found = registeredTools().find((t) => t.name === name);
    return found ? { tool: found, capability: registeredCapability(name) } : undefined;
  };

  it("ships representative happy and unhappy cases for the personal briefing workflow", () => {
    const fixtures = loadSkillFixtures(join(getBuiltinSkillsDir(), "personal-briefing"));
    expect(fixtures.some((f) => f.expect.ok)).toBe(true);
    expect(fixtures.filter((f) => !f.expect.ok).length).toBeGreaterThanOrEqual(3);
  });

  it("passes every bundled fixture through the real registered tools", async () => {
    const skillDirs = readdirSync(getBuiltinSkillsDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(getBuiltinSkillsDir(), e.name));
    const fixtures = skillDirs.flatMap((d) => loadSkillFixtures(d));
    const results = await Promise.all(fixtures.map((f) => runSkillFixture(f, registryResolver)));
    expect(results.filter((r) => !r.passed)).toEqual([]);
  });
});
