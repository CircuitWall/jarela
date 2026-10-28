import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";

export type SkillMetadataIssue = { path: string; message: string };
export interface SkillFrontmatter {
  present: boolean;
  fields: Record<string, unknown>;
  bodyStart: number;
  issues: SkillMetadataIssue[];
}

export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { present: false, fields: {}, bodyStart: 0, issues: [] };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  const invalid = (message: string): SkillFrontmatter => ({
    present: true, fields: {}, bodyStart: end < 0 ? 0 : end + 1,
    issues: [{ path: "frontmatter", message }],
  });
  if (end < 0) return invalid("Missing closing frontmatter delimiter");
  const text = lines.slice(1, end).join("\n");
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) return invalid("Frontmatter exceeds 64 KiB");
  try {
    const doc = parseDocument(text, { schema: "core", uniqueKeys: true });
    const problems = [...doc.errors, ...doc.warnings];
    if (problems.length) return invalid(problems.map((issue) => issue.message).join("; "));
    if (!isMap(doc.contents)) return invalid("Frontmatter must be a YAML mapping");
    const pending: Array<{ value: unknown; depth: number }> = [{ value: doc.contents, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
      const { value, depth } = pending.pop()!;
      if (++nodes > 4096 || depth > 32) return invalid("Frontmatter exceeds depth or node limits");
      if (isAlias(value)) return invalid("YAML aliases are unsupported; use explicit metadata values");
      if (isMap(value)) {
        for (const pair of value.items) {
          if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
            return invalid("Metadata mapping keys must be strings");
          }
          pending.push({ value: pair.value, depth: depth + 1 });
        }
      } else if (isSeq(value)) {
        for (const item of value.items) pending.push({ value: item, depth: depth + 1 });
      } else if (isScalar(value) && typeof value.value === "number" && !Number.isFinite(value.value)) {
        return invalid("Metadata numbers must be finite JSON values");
      }
    }
    const fields: unknown = doc.toJS({ maxAliasCount: 0 });
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) return invalid("Expected metadata object");
    return { present: true, fields: { ...fields }, bodyStart: end + 1, issues: [] };
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
}

export function inspectSkillMetadata(id: string, content: string, directory: string | null) {
  const parsed = parseSkillFrontmatter(content);
  const issues = [...parsed.issues];
  const fields = parsed.fields;
  if (parsed.present && !parsed.issues.length) {
    const name = typeof fields.name === "string" ? fields.name.trim().normalize("NFKC") : "";
    if (!/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(name) || name !== name.toLowerCase() || [...name].length > 64) {
      issues.push({ path: "name", message: "Use 1-64 lowercase Unicode letters, digits and single hyphens" });
    } else if (name !== id.normalize("NFKC")) {
      issues.push({ path: "name", message: "Name must match the skill directory" });
    }
    if (typeof fields.description !== "string" || !fields.description.trim() || [...fields.description].length > 1024) {
      issues.push({ path: "description", message: "Description must contain 1-1024 characters" });
    }
    for (const field of ["license", "compatibility", "allowed-tools"]) {
      if (fields[field] !== undefined && (typeof fields[field] !== "string" || !fields[field].trim())) {
        issues.push({ path: field, message: "Expected a non-empty string" });
      }
    }
    if (typeof fields.compatibility === "string" && [...fields.compatibility].length > 500) {
      issues.push({ path: "compatibility", message: "Compatibility must not exceed 500 characters" });
    }
    const metadata = fields.metadata;
    if (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
      || Object.values(metadata).some((value) => typeof value !== "string"))) {
      issues.push({ path: "metadata", message: "Metadata must map string keys to string values" });
    }
  }
  const standardFields = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
  const unsupported = Object.keys(fields).filter((key) => !standardFields.has(key));
  const notices = unsupported.map((field) => ({
    path: field, message: "Host-specific field preserved, but its behavior is not implemented by Jarela",
  }));
  if (fields["allowed-tools"] !== undefined) {
    notices.push({ path: "allowed-tools", message: "Informational only; does not grant permissions or change Jarela tool policy" });
  }
  if (fields.compatibility !== undefined) {
    notices.push({ path: "compatibility", message: "Author-declared requirements; environment and runtime compatibility are not verified" });
  }
  if (!parsed.present) notices.push({ path: "frontmatter", message: "Legacy instructions have no standard name/description frontmatter" });
  if (directory === null) notices.push({ path: "layout", message: "Legacy flat Markdown has no skill-root resource directory" });
  return {
    status: issues.length ? "invalid" : !parsed.present || directory === null ? "legacy" : unsupported.length ? "extended" : "standard",
    metadata: fields, issues, notices,
    execution_available: false as const,
    limitation: "Metadata validation is not cross-host certification. Resources are untrusted data; scripts are never executed by reading a skill.",
  };
}
