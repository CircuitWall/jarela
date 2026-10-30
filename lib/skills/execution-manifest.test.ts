import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectSkillExecution, parseSkillExecutionManifest, SKILL_INSPECTION_LIMITS,
} from "./execution-manifest";

const manifest = () => ({
  schemaVersion: 1,
  entrypoint: "entry.mjs",
  files: ["entry.mjs"],
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "string" },
});

describe("execution manifest contract", () => {
  it.each(["entry.mjs", "entry.cjs", "scripts with spaces/entry.mjs"])("accepts explicit JavaScript entry %s", (entrypoint) => {
    expect(parseSkillExecutionManifest(JSON.stringify({ ...manifest(), entrypoint, files: [entrypoint] })))
      .toMatchObject({ entrypoint, timeoutMs: 60_000, maxOutputBytes: 65_536 });
  });

  it("preserves the supported schema subset without evaluating it", () => {
    const inputSchema = {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "integer", minimum: 0, maximum: 3, enum: [0, 3] }, minItems: 1, maxItems: 4 },
        text: { type: "string", minLength: 0, maxLength: 10, enum: ["hello"] },
        count: { type: "number", minimum: -0.5, maximum: 2 },
        enabled: { type: "boolean", enum: [true] },
        empty: { type: "null" },
        expiry: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
      },
      required: ["items"],
      additionalProperties: true,
    };
    expect(parseSkillExecutionManifest(JSON.stringify({ ...manifest(), inputSchema })).inputSchema).toEqual(inputSchema);
  });

  it.each([
    { schemaVersion: 2 }, { unknown: true }, { command: "node entry.mjs" },
    { entrypoint: "entry.js", files: ["entry.js"] },
    { entrypoint: "entry.ts", files: ["entry.ts"] },
    { entrypoint: "entry.py", files: ["entry.py"] },
    { files: ["other.mjs"] }, { files: [] },
    { files: ["entry.mjs", "ENTRY.mjs"] },
    { timeoutMs: 0 }, { timeoutMs: 999 }, { timeoutMs: 120001 }, { timeoutMs: 1000.5 },
    { maxOutputBytes: 0 }, { maxOutputBytes: 262145 }, { maxOutputBytes: 1.5 },
    { inputSchema: { type: "array", items: { type: "string" } } },
    { outputSchema: { type: "string", pattern: ".*" } },
    { outputSchema: { $ref: "https://example.test/schema" } },
    { outputSchema: { type: "object", properties: {}, required: ["missing"] } },
    { outputSchema: { type: "object", properties: { x: { type: "string" } }, required: ["x", "x"] } },
    { outputSchema: { type: "object", properties: {}, additionalProperties: { type: "string" } } },
    { outputSchema: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 1 } },
    { outputSchema: { type: "string", minLength: 2, maxLength: 1 } },
    { outputSchema: { type: "number", minimum: 2, maximum: 1 } },
    { outputSchema: { type: "integer", enum: [1.5] } },
    { outputSchema: { type: "boolean", enum: [] } },
    { outputSchema: { anyOf: [] } },
    { outputSchema: { anyOf: [{ type: "null" }] } },
    { outputSchema: { anyOf: Array.from({ length: 5 }, () => ({ type: "null" })) } },
    { outputSchema: { anyOf: [{ type: "null" }, { type: "string", pattern: ".*" }] } },
    { outputSchema: { type: "string", anyOf: [{ type: "null" }, { type: "string" }] } },
    { outputSchema: { anyOf: [{ type: "null" }, { type: "string" }], unknown: true } },
    { outputSchema: { type: "object", properties: JSON.parse('{"__proto__":{"type":"string"}}') } },
  ])("rejects unsupported or invalid fields: %j", (override) => {
    expect(() => parseSkillExecutionManifest(JSON.stringify({ ...manifest(), ...override }))).toThrow();
  });

  it.each([
    "../entry.mjs", "/entry.mjs", "C:/entry.mjs", "scripts\\entry.mjs",
    "scripts/../entry.mjs", "./entry.mjs", "scripts//entry.mjs", "entry.mjs/",
    "entry.mjs:stream", "CON.mjs", "com1.mjs", "scripts./entry.mjs",
    "scripts /entry.mjs", "bad\u0000/entry.mjs", "//server/entry.mjs",
  ])("rejects nonportable or escaping path %j", (file) => {
    expect(() => parseSkillExecutionManifest(JSON.stringify({ ...manifest(), files: ["entry.mjs", file] }))).toThrow();
  });

  it("checks byte limits rather than character counts", () => {
    expect(() => parseSkillExecutionManifest(" ".repeat(SKILL_INSPECTION_LIMITS.manifestBytes + 1))).toThrow(/64 KiB/);
    expect(() => parseSkillExecutionManifest("é".repeat(SKILL_INSPECTION_LIMITS.manifestBytes / 2 + 1))).toThrow(/64 KiB/);
    expect(parseSkillExecutionManifest(JSON.stringify(manifest()).padEnd(SKILL_INSPECTION_LIMITS.manifestBytes)))
      .toMatchObject({ schemaVersion: 1 });
  });

  it("rejects excessive nesting and total JSON nodes before recursive schema parsing", () => {
    let nested: unknown = { type: "string" };
    for (let i = 0; i < 40; i++) nested = { type: "array", items: nested };
    expect(() => parseSkillExecutionManifest(JSON.stringify({ ...manifest(), outputSchema: nested }))).toThrow(/depth or node/);
    expect(() => parseSkillExecutionManifest(JSON.stringify({
      ...manifest(), extra: Array.from({ length: 4096 }, () => null),
    }))).toThrow(/depth or node/);
  });

  it("bounds nested alternatives before recursive parsing and keeps invocation roots explicit", () => {
    const alternatives = [{ type: "null" }, { type: "string" }, { type: "number" }, { type: "boolean" }];
    expect(parseSkillExecutionManifest(JSON.stringify({ ...manifest(), outputSchema: { anyOf: alternatives } })).outputSchema)
      .toEqual({ anyOf: alternatives });
    let nested: unknown = { type: "null" };
    for (let i = 0; i < 20; i++) nested = { anyOf: [nested, { type: "string" }] };
    expect(() => parseSkillExecutionManifest(JSON.stringify({ ...manifest(), outputSchema: nested })))
      .toThrow(/depth or node/);
    expect(() => parseSkillExecutionManifest(JSON.stringify({
      ...manifest(), inputSchema: { anyOf: [{ type: "object", properties: {} }, { type: "null" }] },
    }))).toThrow(/Input must use an object schema/);
  });

  it("accepts numeric boundaries and rejects excess file count", () => {
    for (const [timeoutMs, maxOutputBytes] of [[1000, 1], [120000, 262144]]) {
      expect(parseSkillExecutionManifest(JSON.stringify({ ...manifest(), timeoutMs, maxOutputBytes })))
        .toMatchObject({ timeoutMs, maxOutputBytes });
    }
    const files = ["entry.mjs", ...Array.from({ length: 63 }, (_, i) => `${i}.txt`)];
    expect(parseSkillExecutionManifest(JSON.stringify({ ...manifest(), files })).files).toHaveLength(64);
    expect(() => parseSkillExecutionManifest(JSON.stringify({ ...manifest(), files: [...files, "extra.txt"] }))).toThrow();
  });
});

describe("inert skill execution inspection", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function directory() {
    const dir = mkdtempSync(join(tmpdir(), "jarela-execution-inspection-"));
    dirs.push(dir);
    return dir;
  }
  function bundle(override = {}) {
    const dir = directory();
    writeFileSync(join(dir, "execution.json"), JSON.stringify({ ...manifest(), ...override }));
    writeFileSync(join(dir, "entry.mjs"), 'throw new Error("Inspection must never import me");');
    return dir;
  }

  it("distinguishes flat/prompt-only skills from malformed execution declarations", () => {
    expect(inspectSkillExecution(null)).toEqual({ status: "not_declared", execution_available: false });
    const dir = directory();
    expect(inspectSkillExecution(dir)).toEqual({ status: "not_declared", execution_available: false });
    writeFileSync(join(dir, "execution.json"), "{bad");
    expect(inspectSkillExecution(dir)).toMatchObject({
      status: "invalid", execution_available: false, issues: [{ path: "execution.json", message: "Manifest must contain valid JSON" }],
    });
  });

  it("reports missing roots and declared files explicitly without leaking local paths", () => {
    const dir = bundle({ files: ["entry.mjs", "missing.txt"] });
    const result = inspectSkillExecution(dir);
    expect(result).toMatchObject({ status: "invalid", issues: [{ path: "missing.txt", message: "File inspection failed (ENOENT)" }] });
    expect(JSON.stringify(result)).not.toContain(dir);
    expect(inspectSkillExecution(join(dir, "missing"))).toMatchObject({ status: "invalid" });
  });

  it("reads only metadata and does not execute entry points or package hooks", async () => {
    const dir = bundle();
    const marker = join(dir, "ran");
    writeFileSync(join(dir, "entry.mjs"), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "ran");`);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { postinstall: "node entry.mjs" } }));
    expect(inspectSkillExecution(dir)).toMatchObject({
      status: "inspected", execution_available: false,
      manifest: { entrypoint: "entry.mjs" },
      files: [{ path: "entry.mjs", bytes: expect.any(Number) }],
      total_bytes: expect.any(Number),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(existsSync(marker)).toBe(false);
  });

  it("rechecks metadata on every inspection rather than caching stale success", () => {
    const dir = bundle();
    expect(inspectSkillExecution(dir).status).toBe("inspected");
    writeFileSync(join(dir, "execution.json"), JSON.stringify({ ...manifest(), schemaVersion: 2 }));
    expect(inspectSkillExecution(dir)).toMatchObject({ status: "invalid", issues: [{ path: "schemaVersion" }] });
  });

  it("rejects invalid UTF-8 and oversized manifests", () => {
    const dir = bundle();
    writeFileSync(join(dir, "execution.json"), Buffer.from([0xff]));
    expect(inspectSkillExecution(dir)).toMatchObject({ status: "invalid", issues: [{ message: "Manifest must contain valid UTF-8" }] });
    writeFileSync(join(dir, "execution.json"), " ".repeat(SKILL_INSPECTION_LIMITS.manifestBytes + 1));
    expect(inspectSkillExecution(dir)).toMatchObject({ status: "invalid", issues: [{ message: "Manifest exceeds 64 KiB" }] });
  });

  it("accepts the exact per-file and total byte ceilings, rejecting either excess", () => {
    const files = ["entry.mjs", "a.txt", "b.txt", "c.txt"];
    const dir = bundle({ files });
    for (const file of files) {
      writeFileSync(join(dir, file), "");
      truncateSync(join(dir, file), SKILL_INSPECTION_LIMITS.fileBytes);
    }
    expect(inspectSkillExecution(dir)).toMatchObject({ status: "inspected", total_bytes: SKILL_INSPECTION_LIMITS.totalBytes });
    truncateSync(join(dir, "entry.mjs"), SKILL_INSPECTION_LIMITS.fileBytes + 1);
    expect(inspectSkillExecution(dir)).toMatchObject({ status: "invalid", issues: [{ path: "entry.mjs", message: "Declared file exceeds 1 MiB" }] });
    truncateSync(join(dir, "entry.mjs"), SKILL_INSPECTION_LIMITS.fileBytes);
    writeFileSync(join(dir, "d.txt"), "x");
    writeFileSync(join(dir, "execution.json"), JSON.stringify({ ...manifest(), files: [...files, "d.txt"] }));
    expect(inspectSkillExecution(dir)).toMatchObject({ status: "invalid", issues: [{ message: "Declared files exceed 4 MiB total" }] });
  });

  it("rejects directories in place of manifests or declared regular files", () => {
    const dir = directory();
    mkdirSync(join(dir, "execution.json"));
    expect(inspectSkillExecution(dir)).toMatchObject({ status: "invalid" });
    const other = bundle({ files: ["entry.mjs", "folder"] });
    mkdirSync(join(other, "folder"));
    expect(inspectSkillExecution(other)).toMatchObject({ status: "invalid", issues: [{ path: "folder" }] });
  });

  it("rejects linked directories without following declared paths outside the skill", () => {
    const dir = bundle({ files: ["entry.mjs", "linked/data.txt"] });
    const target = directory();
    writeFileSync(join(target, "data.txt"), "outside");
    symlinkSync(target, join(dir, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(inspectSkillExecution(dir)).toMatchObject({ status: "invalid", issues: [{ path: "linked/data.txt" }] });
    const parent = directory();
    symlinkSync(dir, join(parent, "skill"), process.platform === "win32" ? "junction" : "dir");
    expect(inspectSkillExecution(join(parent, "skill"))).toMatchObject({ status: "invalid" });
  });
});
