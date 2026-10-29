import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { portableSkillPath, regularSkillFile, readSkillTextFile, SkillFileSizeError } from "./bundle-files";

export const SKILL_INSPECTION_LIMITS = {
  manifestBytes: 64 * 1024,
  files: 64,
  fileBytes: 1024 * 1024,
  totalBytes: 4 * 1024 * 1024,
  jsonDepth: 32,
  jsonNodes: 4096,
} as const;

type ValueSchema =
  | { type: "object"; properties: Record<string, ValueSchema>; required?: string[]; additionalProperties?: boolean }
  | { type: "array"; items: ValueSchema; minItems?: number; maxItems?: number }
  | { type: "string"; minLength?: number; maxLength?: number; enum?: string[] }
  | { type: "number" | "integer"; minimum?: number; maximum?: number; enum?: number[] }
  | { type: "boolean"; enum?: boolean[] }
  | { type: "null" };

const nonnegativeInteger = z.number().int().nonnegative();
const valueSchema: z.ZodType<ValueSchema> = z.lazy(() => z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("object"),
    properties: z.preprocess((value, ctx) => {
      if (value && typeof value === "object" && Object.hasOwn(value, "__proto__")) {
        ctx.addIssue({ code: "custom", message: "Reserved schema property name: __proto__" });
      }
      return value;
    }, z.record(z.string(), valueSchema)),
    required: z.array(z.string()).optional(),
    additionalProperties: z.boolean().optional(),
  }).superRefine((schema, ctx) => {
    const required = schema.required ?? [];
    if (new Set(required).size !== required.length || required.some((key) => !Object.hasOwn(schema.properties, key))) {
      ctx.addIssue({ code: "custom", path: ["required"], message: "Required keys must be unique declared properties" });
    }
  }),
  z.strictObject({
    type: z.literal("array"), items: valueSchema,
    minItems: nonnegativeInteger.optional(), maxItems: nonnegativeInteger.optional(),
  }).refine((s) => s.minItems === undefined || s.maxItems === undefined || s.minItems <= s.maxItems, "minItems exceeds maxItems"),
  z.strictObject({
    type: z.literal("string"),
    minLength: nonnegativeInteger.optional(), maxLength: nonnegativeInteger.optional(),
    enum: z.array(z.string()).min(1).optional(),
  }).refine((s) => s.minLength === undefined || s.maxLength === undefined || s.minLength <= s.maxLength, "minLength exceeds maxLength"),
  z.strictObject({
    type: z.enum(["number", "integer"]),
    minimum: z.number().optional(), maximum: z.number().optional(),
    enum: z.array(z.number()).min(1).optional(),
  }).superRefine((s, ctx) => {
    if (s.minimum !== undefined && s.maximum !== undefined && s.minimum > s.maximum) {
      ctx.addIssue({ code: "custom", message: "minimum exceeds maximum" });
    }
    if (s.type === "integer" && s.enum?.some((value) => !Number.isInteger(value))) {
      ctx.addIssue({ code: "custom", path: ["enum"], message: "Integer enum values must be integers" });
    }
  }),
  z.strictObject({ type: z.literal("boolean"), enum: z.array(z.boolean()).min(1).optional() }),
  z.strictObject({ type: z.literal("null") }),
]));

const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  entrypoint: portableSkillPath.refine((value) => /\.(mjs|cjs)$/.test(value), "Only .mjs and .cjs entry points are supported"),
  files: z.array(portableSkillPath).min(1).max(SKILL_INSPECTION_LIMITS.files),
  inputSchema: valueSchema.refine((schema) => schema.type === "object", "Input must use an object schema"),
  outputSchema: valueSchema,
  timeoutMs: z.number().int().min(1000).max(120_000).default(60_000),
  maxOutputBytes: z.number().int().min(1).max(256 * 1024).default(64 * 1024),
}).superRefine((manifest, ctx) => {
  if (!manifest.files.includes(manifest.entrypoint)) {
    ctx.addIssue({ code: "custom", path: ["entrypoint"], message: "Entry point must be included in files" });
  }
  if (new Set(manifest.files.map((file) => file.toLowerCase())).size !== manifest.files.length) {
    ctx.addIssue({ code: "custom", path: ["files"], message: "File paths must be unique, ignoring case" });
  }
});

export type SkillExecutionManifest = z.infer<typeof manifestSchema>;
type InspectionIssue = { path: string; message: string };
export type SkillExecutionInspection =
  | { status: "not_declared"; execution_available: false }
  | { status: "invalid"; execution_available: false; issues: InspectionIssue[] }
  | {
    status: "inspected"; execution_available: false; manifest: SkillExecutionManifest;
    files: Array<{ path: string; bytes: number }>; total_bytes: number;
  };

export function assertBoundedSkillJson(value: unknown, label = "Manifest"): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (++nodes > SKILL_INSPECTION_LIMITS.jsonNodes || entry.depth > SKILL_INSPECTION_LIMITS.jsonDepth) {
      throw new Error(`${label} JSON exceeds depth or node limits`);
    }
    if (typeof entry.value === "number" && !Number.isFinite(entry.value)) {
      throw new Error(`${label} JSON must contain finite numbers`);
    }
    if (entry.value && typeof entry.value === "object") {
      for (const child of Object.values(entry.value)) {
        pending.push({ value: child, depth: entry.depth + 1 });
      }
    }
  }
}

export function parseSkillExecutionManifest(text: string): SkillExecutionManifest {
  if (Buffer.byteLength(text, "utf8") > SKILL_INSPECTION_LIMITS.manifestBytes) {
    throw new Error("Manifest exceeds 64 KiB");
  }
  const raw: unknown = JSON.parse(text);
  assertBoundedSkillJson(raw);
  return manifestSchema.parse(raw);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}

function readManifest(root: string): string {
  try {
    return readSkillTextFile(root, "execution.json", SKILL_INSPECTION_LIMITS.manifestBytes).content.replace(/^\uFEFF/, "");
  } catch (error) {
    if (error instanceof SkillFileSizeError) throw new Error("Manifest exceeds 64 KiB");
    throw error;
  }
}

export function inspectSkillExecution(directory: string | null): SkillExecutionInspection {
  if (directory === null) return { status: "not_declared", execution_available: false };
  let field = "execution.json";
  try {
    const root = lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Skill directory must not be a symbolic link");
    try {
      lstatSync(join(directory, "execution.json"));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { status: "not_declared", execution_available: false };
      throw error;
    }
    const manifest = parseSkillExecutionManifest(readManifest(directory));
    const files: Array<{ path: string; bytes: number }> = [];
    let total = 0;
    for (const file of manifest.files) {
      field = file;
      const stat = regularSkillFile(directory, file);
      if (stat.size > SKILL_INSPECTION_LIMITS.fileBytes) throw new Error("Declared file exceeds 1 MiB");
      total += stat.size;
      if (total > SKILL_INSPECTION_LIMITS.totalBytes) throw new Error("Declared files exceed 4 MiB total");
      files.push({ path: file, bytes: stat.size });
    }
    return { status: "inspected", execution_available: false, manifest, files, total_bytes: total };
  } catch (error) {
    const issues = error instanceof z.ZodError
      ? error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join(".") || "execution.json", message: issue.message }))
      : [{
        path: field,
        message: errorCode(error) === "ERR_ENCODING_INVALID_ENCODED_DATA" ? "Manifest must contain valid UTF-8"
          : errorCode(error) ? `File inspection failed (${errorCode(error)})`
          : error instanceof SyntaxError ? "Manifest must contain valid JSON"
            : error instanceof Error ? error.message : "Skill execution inspection failed",
      }];
    return { status: "invalid", execution_available: false, issues };
  }
}
