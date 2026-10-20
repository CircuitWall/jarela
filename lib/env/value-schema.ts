import { z } from "zod";
import type { EnvVarDef } from "./schema";

export function envValueSchema(def: EnvVarDef): z.ZodType<string> {
  if (def.type === "int") {
    return z.string()
      .refine((value) => {
        const number = Number(value.trim());
        return value.trim() !== "" && Number.isFinite(number) && Number.isInteger(number);
      }, { error: "expected integer" })
      .superRefine((value, context) => {
        const number = Number(value);
        if (def.min !== undefined && number < def.min) {
          context.addIssue({ code: "custom", message: `minimum is ${def.min}` });
        }
        if (def.max !== undefined && number > def.max) {
          context.addIssue({ code: "custom", message: `maximum is ${def.max}` });
        }
      })
      .describe(integerDescription(def));
  }

  if (def.type === "bool") {
    return booleanStringSchema();
  }

  if (def.type === "enum") {
    const choices = def.enumValues ?? [];
    if (choices.length === 0) return z.never();
    return z.enum([...choices] as [string, ...string[]], {
      error: `expected one of: ${choices.join(", ")}`,
    }).describe(`Choose one of: ${choices.join(", ")}.`);
  }

  return z.string().describe("Text value.");
}

export function envToolValueSchema(def: EnvVarDef): z.ZodType<string | number | boolean> {
  if (def.type === "int") {
    let numberSchema = z.number().int();
    if (def.min !== undefined) numberSchema = numberSchema.min(def.min);
    if (def.max !== undefined) numberSchema = numberSchema.max(def.max);
    const legacyStringSchema = z.string().refine(
      (value) => envValueSchema(def).safeParse(value).success,
      { error: (issue) => issue.input ? "expected integer within the declared bounds" : "expected integer" },
    );
    return z.union([numberSchema, legacyStringSchema])
      .describe(integerDescription(def));
  }

  if (def.type === "bool") {
    return z.union([
      z.boolean(),
      booleanStringSchema(),
    ]).describe("Boolean value. Also accepts the legacy strings true, false, 1, or 0.");
  }

  if (def.type === "enum") {
    const choices = def.enumValues ?? [];
    if (choices.length === 0) return z.never();
    return z.enum([...choices] as [string, ...string[]])
      .describe(`Choose one of: ${choices.join(", ")}.`);
  }

  return z.string().describe("Text value.");
}

function booleanStringSchema(): z.ZodString {
  return z.string()
    .regex(/^\s*(0|1|true|false)\s*$/i, { error: "expected bool (0/1/true/false)" })
    .describe("Boolean value: true or false (also accepts 1 or 0, with surrounding whitespace).");
}

function integerDescription(def: EnvVarDef): string {
  const bounds = [
    def.min !== undefined ? `minimum ${def.min}` : null,
    def.max !== undefined ? `maximum ${def.max}` : null,
  ].filter((bound): bound is string => bound !== null);
  return `Integer value${bounds.length ? ` (${bounds.join(", ")})` : ""}.`;
}