/**
 * The model-facing surface of a Jarela release: every prompt text Jarela
 * sends and every built-in tool's description and parameter schema. Release
 * changesets diff two snapshots so version adoption can tell which user
 * instructions, skills, settings, and scheduled prompts may need adapting.
 * Pure functions only — collection lives in surface-collect.ts.
 */

export const SURFACE_SNAPSHOT_SCHEMA_VERSION = 1;

export interface SurfacePrompt {
  source: string;
  text: string;
}

export interface SurfaceTool {
  description: string;
  parameters: unknown;
}

export interface SurfaceSnapshot {
  schema_version: number;
  version: string;
  prompts: Record<string, SurfacePrompt>;
  tools: Record<string, SurfaceTool>;
}

export type SurfaceChangeKind = "added" | "removed" | "changed";

export interface PromptChange {
  id: string;
  source: string;
  change: SurfaceChangeKind;
  added_lines: string[];
  removed_lines: string[];
  /** Lines beyond the excerpt cap, so readers know the excerpt is partial. */
  omitted_lines: number;
}

export interface ToolChange {
  name: string;
  change: SurfaceChangeKind;
  description_changed: boolean;
  description?: string;
  previous_description?: string;
  params_added: string[];
  params_removed: string[];
  params_changed: string[];
  required_added: string[];
  required_removed: string[];
}

export interface SurfaceDelta {
  prompts: PromptChange[];
  tools: ToolChange[];
}

const SECTION_HEADER = /^--- (.+) ---$/;
/** Sections whose content depends on the host machine or the moment of collection. */
const VOLATILE_SECTIONS = new Set(["Host environment", "System signals"]);
const VOLATILE_LINES = [/^Current time:/, /^Current local date and time:/];
const MAX_EXCERPT_LINES = 12;
const MAX_LINE_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 600;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Splits an assembled agent system prompt into its `--- Title ---` sections,
 * dropping host- and time-dependent content so two snapshots of the same code
 * compare equal on any machine.
 */
export function splitSystemPromptSections(prompt: string): Record<string, string> {
  const sections: Record<string, string[]> = {};
  let current = "Preamble";
  for (const raw of prompt.split(/\r?\n/)) {
    const header = SECTION_HEADER.exec(raw.trim());
    if (header) {
      current = header[1].trim();
      sections[current] ??= [];
      continue;
    }
    if (raw.startsWith("<!-- jarela:")) continue;
    if (VOLATILE_LINES.some((pattern) => pattern.test(raw.trim()))) continue;
    (sections[current] ??= []).push(raw);
  }
  const out: Record<string, string> = {};
  for (const [title, lines] of Object.entries(sections)) {
    if (VOLATILE_SECTIONS.has(title)) continue;
    const text = lines.join("\n").trim();
    if (text) out[title] = text;
  }
  return out;
}

function significantLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function excerpt(lines: string[]): { lines: string[]; omitted: number } {
  return {
    lines: lines.slice(0, MAX_EXCERPT_LINES).map((line) => clip(line, MAX_LINE_CHARS)),
    omitted: Math.max(0, lines.length - MAX_EXCERPT_LINES),
  };
}

export function diffPrompts(
  prev: Record<string, SurfacePrompt>,
  next: Record<string, SurfacePrompt>,
): PromptChange[] {
  const ids = [...new Set([...Object.keys(prev), ...Object.keys(next)])].sort();
  const changes: PromptChange[] = [];
  for (const id of ids) {
    const before = prev[id];
    const after = next[id];
    if (before && after && before.text === after.text) continue;
    const beforeLines = before ? significantLines(before.text) : [];
    const afterLines = after ? significantLines(after.text) : [];
    const beforeSet = new Set(beforeLines);
    const afterSet = new Set(afterLines);
    const added = excerpt(afterLines.filter((line) => !beforeSet.has(line)));
    const removed = excerpt(beforeLines.filter((line) => !afterSet.has(line)));
    // Whitespace-only edits change the text but not what the model reads.
    if (before && after && added.lines.length === 0 && removed.lines.length === 0) continue;
    changes.push({
      id,
      source: (after ?? before).source,
      change: !before ? "added" : !after ? "removed" : "changed",
      added_lines: before ? added.lines : [],
      removed_lines: after ? removed.lines : [],
      omitted_lines: (before ? added.omitted : 0) + (after ? removed.omitted : 0),
    });
  }
  return changes;
}

interface ObjectSchema {
  properties: Record<string, unknown>;
  required: string[];
}

function objectSchema(parameters: unknown): ObjectSchema {
  const schema = parameters && typeof parameters === "object" ? parameters as Record<string, unknown> : {};
  const properties = schema.properties && typeof schema.properties === "object"
    ? schema.properties as Record<string, unknown>
    : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === "string")
    : [];
  return { properties, required };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function diffTools(
  prev: Record<string, SurfaceTool>,
  next: Record<string, SurfaceTool>,
): ToolChange[] {
  const names = [...new Set([...Object.keys(prev), ...Object.keys(next)])].sort();
  const changes: ToolChange[] = [];
  for (const name of names) {
    const before = prev[name];
    const after = next[name];
    const beforeSchema = objectSchema(before?.parameters);
    const afterSchema = objectSchema(after?.parameters);
    const beforeParams = Object.keys(beforeSchema.properties);
    const afterParams = Object.keys(afterSchema.properties);
    const paramsAdded = afterParams.filter((param) => !(param in beforeSchema.properties)).sort();
    const paramsRemoved = beforeParams.filter((param) => !(param in afterSchema.properties)).sort();
    const paramsChanged = afterParams
      .filter((param) => param in beforeSchema.properties)
      .filter((param) => stableJson(beforeSchema.properties[param]) !== stableJson(afterSchema.properties[param]))
      .sort();
    const requiredAdded = afterSchema.required.filter((param) => !beforeSchema.required.includes(param)).sort();
    const requiredRemoved = beforeSchema.required.filter((param) => !afterSchema.required.includes(param)).sort();
    const descriptionChanged = Boolean(before && after && before.description.trim() !== after.description.trim());
    const schemaChanged = paramsAdded.length + paramsRemoved.length + paramsChanged.length
      + requiredAdded.length + requiredRemoved.length > 0;
    if (before && after && !descriptionChanged && !schemaChanged) continue;
    changes.push({
      name,
      change: !before ? "added" : !after ? "removed" : "changed",
      description_changed: descriptionChanged,
      ...(after && (!before || descriptionChanged) ? { description: clip(after.description.trim(), MAX_DESCRIPTION_CHARS) } : {}),
      ...(before && after && descriptionChanged ? { previous_description: clip(before.description.trim(), MAX_DESCRIPTION_CHARS) } : {}),
      params_added: after ? paramsAdded : [],
      params_removed: before && after ? paramsRemoved : [],
      params_changed: paramsChanged,
      required_added: after ? requiredAdded : [],
      required_removed: before && after ? requiredRemoved : [],
    });
  }
  return changes;
}

export function diffSurfaces(prev: SurfaceSnapshot, next: SurfaceSnapshot): SurfaceDelta {
  return {
    prompts: diffPrompts(prev.prompts, next.prompts),
    tools: diffTools(prev.tools, next.tools),
  };
}
