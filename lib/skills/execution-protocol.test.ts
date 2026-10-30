import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseSkillExecutionManifest } from "./execution-manifest";
import { skillInvocationDigest } from "./execution-consent";
import {
  parseSkillInvocationJson, validateSkillInvocation, validateSkillResult, SKILL_INVOCATION_MAX_BYTES,
} from "./execution-protocol";

function manifest(inputSchema: unknown = { type: "object", properties: {} }, outputSchema: unknown = { type: "null" }, maxOutputBytes = 65536) {
  return parseSkillExecutionManifest(JSON.stringify({
    schemaVersion: 1, entrypoint: "entry.mjs", files: ["entry.mjs"], inputSchema, outputSchema, maxOutputBytes,
  }));
}

describe("inert skill invocation/result protocol", () => {
  it("validates nullable fields and explicit result alternatives without coercion", () => {
    const nullable = { anyOf: [{ type: "string", minLength: 2 }, { type: "null" }] };
    const checked = manifest({
      type: "object", properties: { expiry: nullable }, required: ["expiry"], additionalProperties: false,
    }, {
      anyOf: [
        { type: "object", properties: { ok: { type: "boolean", enum: [true] } }, required: ["ok"], additionalProperties: false },
        { type: "object", properties: { error: { type: "string", minLength: 1 } }, required: ["error"], additionalProperties: false },
      ],
    });
    expect(validateSkillInvocation(checked, '{"expiry":null}')).toEqual({ expiry: null });
    expect(validateSkillInvocation(checked, '{"expiry":"UTC"}')).toEqual({ expiry: "UTC" });
    for (const text of ['{"expiry":""}', '{"expiry":"x"}', '{"expiry":0}', '{}']) {
      expect(() => validateSkillInvocation(checked, text)).toThrow(z.ZodError);
    }
    expect(validateSkillResult(checked, '{"ok":true}')).toEqual({ ok: true });
    expect(validateSkillResult(checked, '{"error":"invalid"}')).toEqual({ error: "invalid" });
    for (const text of ['{"ok":false}', '{"error":""}', '{"ok":true,"extra":1}', 'null']) {
      expect(() => validateSkillResult(checked, text)).toThrow(z.ZodError);
    }
  });

  it("allows overlapping and nested alternatives without leaking rejected-branch issues", () => {
    const checked = manifest(undefined, {
      anyOf: [
        { type: "string", maxLength: 1 },
        { anyOf: [{ type: "string", minLength: 1 }, { type: "array", items: { type: "null" } }] },
      ],
    });
    expect(validateSkillResult(checked, '"x"')).toBe("x");
    expect(validateSkillResult(checked, '"long"')).toBe("long");
    expect(validateSkillResult(checked, '[null]')).toEqual([null]);
    expect(() => validateSkillResult(checked, '[1]')).toThrow(/at least one/);
  });

  it("checks nested fields without coercion, stripping, defaults or input mutation", () => {
    const schema = {
      type: "object", properties: {
        items: { type: "array", items: { type: "integer", minimum: 0, maximum: 3, enum: [0, 3] }, minItems: 1, maxItems: 2 },
        text: { type: "string", minLength: 1, maxLength: 4, enum: ["hell"] },
        count: { type: "number", minimum: -0.5, maximum: 2 },
        enabled: { type: "boolean", enum: [true] }, empty: { type: "null" },
      }, required: ["items", "text", "enabled", "empty"], additionalProperties: false,
    };
    const checked = manifest(schema, schema);
    const input = { items: [0, 3], text: "hell", count: -0.5, enabled: true, empty: null };
    const text = JSON.stringify(input);
    expect(validateSkillInvocation(checked, text)).toEqual(input);
    expect(validateSkillResult(checked, text)).toEqual(input);
    expect(JSON.stringify(checked.inputSchema)).toBe(JSON.stringify(schema));
    for (const change of [
      { items: [] }, { items: [0, 3, 0] }, { items: [1] }, { items: [0.5] }, { items: ["0"] },
      { text: "" }, { text: "hello" }, { text: "no" }, { count: -1 }, { count: 3 },
      { enabled: false }, { enabled: "true" }, { empty: false }, { extra: 1 },
    ]) {
      expect(() => validateSkillInvocation(checked, JSON.stringify({ ...input, ...change }))).toThrow(z.ZodError);
      expect(() => validateSkillResult(checked, JSON.stringify({ ...input, ...change }))).toThrow(z.ZodError);
    }
    expect(() => validateSkillInvocation(checked, '{"items":[0]}')).toThrow(z.ZodError);
  });

  it.each([
    [{ type: "string" }, '"hello"', "hello"],
    [{ type: "number" }, "1.5", 1.5],
    [{ type: "integer" }, "2", 2],
    [{ type: "boolean" }, "false", false],
    [{ type: "null" }, "null", null],
    [{ type: "array", items: { type: "string" } }, '["x"]', ["x"]],
    [{ type: "object", properties: {} }, '{"extra":1}', { extra: 1 }],
  ])("accepts a single output matching %j", (schema, text, expected) => {
    expect(validateSkillResult(manifest(undefined, schema), text)).toEqual(expected);
  });

  it.each([
    [{ type: "string" }, "1"], [{ type: "number" }, '"1"'],
    [{ type: "integer" }, "1.5"], [{ type: "boolean" }, "0"],
    [{ type: "null" }, "{}"], [{ type: "array", items: { type: "null" } }, "{}"],
    [{ type: "object", properties: {} }, "[]"],
  ])("rejects output type mismatch %j", (schema, text) => {
    expect(() => validateSkillResult(manifest(undefined, schema), text)).toThrow(z.ZodError);
  });

  it.each(["", "{", "{}\n{}", '{"x":undefined}', '{"x":NaN}'])("rejects malformed or multiple values %j", (text) => {
    expect(() => validateSkillInvocation(manifest(), text)).toThrow(/exactly one JSON/);
    expect(() => validateSkillResult(manifest(), text)).toThrow(/exactly one JSON/);
  });

  it.each(["null", "[]", "true", "1", '"text"'])("requires an invocation object: %s", (text) => {
    expect(() => parseSkillInvocationJson(text)).toThrow(/JSON object/);
    expect(() => skillInvocationDigest(text)).toThrow(/JSON object/);
  });

  it("uses UTF-8 bytes, rejects excess before parsing, and shares exact-byte digest checks", () => {
    const exact = "{}".padEnd(SKILL_INVOCATION_MAX_BYTES);
    expect(validateSkillInvocation(manifest(), exact)).toEqual({});
    expect(skillInvocationDigest(exact)).not.toBe(skillInvocationDigest("{}"));
    expect(() => validateSkillInvocation(manifest(), exact + " ")).toThrow(/64 KiB/);
    expect(() => skillInvocationDigest(exact + " ")).toThrow(/64 KiB/);
    expect(() => validateSkillInvocation(manifest(), JSON.stringify({ text: "é".repeat(32768) }))).toThrow(/64 KiB/);
    const checked = manifest(undefined, { type: "string" }, 6);
    expect(validateSkillResult(checked, '"éé"')).toBe("éé");
    expect(() => validateSkillResult(checked, '"ééé"')).toThrow(/UTF-8 bytes/);
  });

  it("counts string bounds in Unicode code points rather than UTF-16 units", () => {
    const checked = manifest(undefined, { type: "string", minLength: 1, maxLength: 1 });
    expect(validateSkillResult(checked, JSON.stringify("😀"))).toBe("😀");
    expect(() => validateSkillResult(checked, JSON.stringify("😀x"))).toThrow(/too long/);
  });

  it("enforces the minimum and maximum permitted output-byte budgets exactly", () => {
    expect(validateSkillResult(manifest(undefined, { type: "integer" }, 1), "0")).toBe(0);
    expect(() => validateSkillResult(manifest(undefined, { type: "integer" }, 1), "10")).toThrow(/1 UTF-8 bytes/);
    const checked = manifest(undefined, { type: "string" }, 256 * 1024);
    const exact = JSON.stringify("x".repeat(256 * 1024 - 2));
    expect(validateSkillResult(checked, exact)).toHaveLength(256 * 1024 - 2);
    expect(() => validateSkillResult(checked, exact + " ")).toThrow(/262144 UTF-8 bytes/);
  });

  it("accepts exactly 4096 value nodes and depth 32 but rejects either boundary plus one", () => {
    const checked = manifest(undefined, { type: "object", properties: {} });
    const exactNodes = JSON.stringify({ many: Array(4094).fill(null) });
    expect(validateSkillInvocation(checked, exactNodes)).toHaveProperty("many");
    expect(() => validateSkillInvocation(checked, JSON.stringify({ many: Array(4095).fill(null) }))).toThrow(/depth or node/);
    let nested: unknown = null;
    for (let i = 0; i < 31; i++) nested = [nested];
    expect(validateSkillInvocation(checked, JSON.stringify({ nested }))).toHaveProperty("nested");
    expect(() => validateSkillInvocation(checked, JSON.stringify({ nested: [nested] }))).toThrow(/depth or node/);
  });

  it("permits undeclared properties by default or explicit true, but checks declared properties", () => {
    for (const additional of [{}, { additionalProperties: true }]) {
      const checked = manifest({ type: "object", properties: { known: { type: "string" } }, ...additional });
      expect(validateSkillInvocation(checked, '{"extra":[1,null]}')).toEqual({ extra: [1, null] });
      expect(() => validateSkillInvocation(checked, '{"known":1}')).toThrow(/Expected string/);
    }
  });

  it("checks own keys, including prototype-looking names, without prototype mutation", () => {
    const strict = manifest({ type: "object", properties: {}, additionalProperties: false });
    expect(() => validateSkillInvocation(strict, '{"constructor":1,"__proto__":{}}')).toThrow(/Additional property/);
    const properties: unknown = JSON.parse('{"constructor":{"type":"integer"}}');
    const checked = manifest({ type: "object", properties, required: ["constructor"] });
    const result = validateSkillInvocation(checked, '{"__proto__":"data","constructor":2}');
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(() => validateSkillInvocation(checked, "{}")).toThrow(/Required property/);
    expect(() => manifest({
      type: "object", properties: JSON.parse('{"__proto__":{"type":"string"}}'),
    })).toThrow(z.ZodError);
  });

  it("rejects non-finite numbers and depth/node excess even in allowed additional properties", () => {
    expect(() => validateSkillInvocation(manifest(), '{"extra":1e999}')).toThrow(/finite numbers/);
    expect(() => validateSkillResult(manifest(undefined, { type: "number" }), "1e999")).toThrow(/finite numbers/);
    let nested: unknown = null;
    for (let i = 0; i < 34; i++) nested = [nested];
    for (const text of [JSON.stringify({ nested }), JSON.stringify({ many: Array(4096).fill(null) })]) {
      expect(() => validateSkillInvocation(manifest(), text)).toThrow(/depth or node/);
      expect(() => validateSkillResult(manifest(undefined, { type: "object", properties: {} }), text)).toThrow(/depth or node/);
    }
  });

  it("returns bounded path-specific issues without echoing invalid argument values", () => {
    const checked = manifest({ type: "object", properties: {}, additionalProperties: false });
    try {
      validateSkillInvocation(checked, JSON.stringify(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, "sensitive-value"]))));
      expect.fail("Expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(z.ZodError);
      if (!(error instanceof z.ZodError)) throw error;
      expect(error.issues).toHaveLength(20);
      expect(error.issues[0].path).toEqual(["field0"]);
      expect(error.message).not.toContain("sensitive-value");
    }
  });

  it("bounds failed-alternative diagnostics at the original field paths without echoing values", () => {
    const properties = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [
      `field${index}`, { anyOf: [{ type: "integer" }, { type: "null" }] },
    ]));
    const checked = manifest({ type: "object", properties });
    const input = Object.fromEntries(Object.keys(properties).map((key) => [key, "private-value"]));
    try {
      validateSkillInvocation(checked, JSON.stringify(input));
      expect.fail("Expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(z.ZodError);
      if (!(error instanceof z.ZodError)) throw error;
      expect(error.issues).toHaveLength(20);
      expect(error.issues[0].path).toEqual(["field0"]);
      expect(error.message).not.toContain("private-value");
    }
  });
});
