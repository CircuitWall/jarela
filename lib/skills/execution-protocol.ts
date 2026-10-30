import { z } from "zod";
import { assertBoundedSkillJson, type SkillExecutionManifest } from "./execution-manifest";

export const SKILL_INVOCATION_MAX_BYTES = 64 * 1024;
const MAX_ISSUES = 20;
type ValueSchema = SkillExecutionManifest["outputSchema"];
export type SkillJsonValue = null | boolean | number | string | SkillJsonValue[] | { [key: string]: SkillJsonValue };
export type SkillJsonObject = { [key: string]: SkillJsonValue };

function parseJson(text: string, label: string, maxBytes: number): SkillJsonValue {
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    const limit = maxBytes === SKILL_INVOCATION_MAX_BYTES ? "64 KiB" : `${maxBytes} UTF-8 bytes`;
    throw new Error(`${label} exceeds ${limit}`);
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`${label} must contain exactly one JSON value`);
  }
  assertBoundedSkillJson(value, label);
  return value as SkillJsonValue;
}

export function parseSkillInvocationJson(text: string): SkillJsonObject {
  const value = parseJson(text, "Invocation", SKILL_INVOCATION_MAX_BYTES);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invocation must be a JSON object");
  }
  return value;
}

function checkValue(value: SkillJsonValue, schema: ValueSchema): void {
  const issues: z.core.$ZodIssue[] = [];
  function issue(path: (string | number)[], message: string) {
    if (issues.length < MAX_ISSUES) issues.push({ code: "custom", path, message });
  }
  function visit(current: SkillJsonValue, rule: ValueSchema, path: (string | number)[]) {
    if (issues.length >= MAX_ISSUES) return;
    if ("anyOf" in rule) {
      for (const alternative of rule.anyOf) {
        try {
          checkValue(current, alternative);
          return;
        } catch (error) {
          if (!(error instanceof z.ZodError)) throw error;
        }
      }
      issue(path, "Value must match at least one anyOf schema");
      return;
    }
    switch (rule.type) {
      case "object":
        if (current === null || typeof current !== "object" || Array.isArray(current)) {
          issue(path, "Expected object"); return;
        }
        for (const key of rule.required ?? []) {
          if (!Object.hasOwn(current, key)) issue([...path, key], "Required property is missing");
        }
        for (const [key, child] of Object.entries(current)) {
          if (Object.hasOwn(rule.properties, key)) visit(child, rule.properties[key], [...path, key]);
          else if (rule.additionalProperties === false) issue([...path, key], "Additional property is not allowed");
        }
        return;
      case "array":
        if (!Array.isArray(current)) { issue(path, "Expected array"); return; }
        if (rule.minItems !== undefined && current.length < rule.minItems) issue(path, "Array has too few items");
        if (rule.maxItems !== undefined && current.length > rule.maxItems) issue(path, "Array has too many items");
        current.forEach((child, index) => visit(child, rule.items, [...path, index]));
        return;
      case "string": {
        if (typeof current !== "string") { issue(path, "Expected string"); return; }
        const length = Array.from(current).length;
        if (rule.minLength !== undefined && length < rule.minLength) issue(path, "String is too short");
        if (rule.maxLength !== undefined && length > rule.maxLength) issue(path, "String is too long");
        if (rule.enum && !rule.enum.includes(current)) issue(path, "Value is not in the allowed enum");
        return;
      }
      case "number":
      case "integer":
        if (typeof current !== "number" || (rule.type === "integer" && !Number.isInteger(current))) {
          issue(path, `Expected ${rule.type}`); return;
        }
        if (rule.minimum !== undefined && current < rule.minimum) issue(path, "Number is below minimum");
        if (rule.maximum !== undefined && current > rule.maximum) issue(path, "Number is above maximum");
        if (rule.enum && !rule.enum.includes(current)) issue(path, "Value is not in the allowed enum");
        return;
      case "boolean":
        if (typeof current !== "boolean") { issue(path, "Expected boolean"); return; }
        if (rule.enum && !rule.enum.includes(current)) issue(path, "Value is not in the allowed enum");
        return;
      case "null":
        if (current !== null) issue(path, "Expected null");
    }
  }
  visit(value, schema, []);
  if (issues.length > 0) throw new z.ZodError(issues);
}

// Callers must use the strict manifest parser; these helpers never execute code.
export function validateSkillInvocation(manifest: SkillExecutionManifest, text: string): SkillJsonObject {
  const value = parseSkillInvocationJson(text);
  checkValue(value, manifest.inputSchema);
  return value;
}

export function validateSkillResult(manifest: SkillExecutionManifest, text: string): SkillJsonValue {
  const value = parseJson(text, "Result", manifest.maxOutputBytes);
  checkValue(value, manifest.outputSchema);
  return value;
}
