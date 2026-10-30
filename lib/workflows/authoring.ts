import { createHash } from "node:crypto";
import { z } from "zod";
import { portableSkillPath } from "@/lib/skills/bundle-files";
import { syntheticToolFiles } from "./authoring-scaffold";
import { SECRET_PATTERNS } from "../../scripts/lib/secret-patterns.mjs";

const utf8Text = z.string().refine((value) => value.isWellFormed() && !value.includes("\0"), "Expected well-formed UTF-8 text without NUL");
const text = utf8Text.min(1).max(2000).refine((value) => value.trim().length > 0, "Text cannot be blank");
const name = z.string().regex(/^[a-z][a-z0-9_]{2,63}$/);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const file = z.strictObject({
  path: portableSkillPath,
  before: utf8Text.max(16384).nullable(),
  after: utf8Text.max(16384).nullable(),
});
export const ScaffoldExtensionInput = z.strictObject({
  name,
  goal: text,
  discovery: z.strictObject({
    decision: z.enum(["reuse", "configure", "author"]),
    evidence: text,
  }),
});
export const ContributionBundleInput = z.strictObject({
  destination: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
  branch: z.string().regex(/^(feat|fix|docs|test|chore|refactor)\/[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  base_revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  classification: z.enum(["core", "extension"]),
  summary: text,
  ownership: z.enum(["user_owned", "licensed_for_contribution", "unknown"]),
  license_review: text,
  worktree: z.enum(["clean", "dirty", "unknown"]),
  tests: z.strictObject({ status: z.enum(["passed", "failed", "not_run"]), command: text, evidence: text }),
  files: z.array(file).min(1).max(32),
});

type Issue = { path: string; message: string };
const issue = (path: string, message: string): Issue => ({ path, message });
const failed = (issues: Issue[]) => ({ ok: false as const, issues, execution_authorized: false as const, installation_authorized: false as const, publication_authorized: false as const });
function parse<T>(schema: z.ZodType<T>, input: unknown) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { success: false as const, issues: parsed.error.issues.map((entry) =>
    issue(entry.path.join("."), entry.code === "unrecognized_keys" ? "Unexpected fields are not supported" : entry.message)) };
  if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > 65536) {
    return { success: false as const, issues: [issue("$", "Input exceeds 64 KiB")] };
  }
  return parsed;
}

// Conservative blockers, not a proof of sanitization. Never return matched values.
function sensitive(value: string) {
  return SECRET_PATTERNS.some(({ re }) => re.test(value))
    || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\b(?:authorization\s*[:=]\s*["']?(?:bearer|basic)\s+\S+|(?:password|api[_-]?key|client_secret|refresh_token|access_token)\s*[:=]\s*["']?[A-Za-z0-9_+/=-]{8,})/i.test(value)
    || /(?:[A-Z]:[\\/](?:Users|Documents and Settings)[\\/]|\/(?:home|Users)\/)[^\\/\s"']+/i.test(value)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value);
}
export function containsSensitive(value: unknown): boolean {
  if (typeof value === "string") return sensitive(value);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsSensitive);
  return false;
}
const sensitivePath = /(?:^|\/)(?:\.git|\.env(?:\.[^/]*)?|\.npmrc|\.netrc|id_rsa|id_ed25519|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|memory|chats?|transcripts?|logs?)(?:\/|$)|\.(?:pem|key|sqlite|db|log)$/i;

export function scaffoldExtension(input: unknown) {
  const parsed = parse(ScaffoldExtensionInput, input);
  if (!parsed.success) return failed(parsed.issues);
  const value = parsed.data;
  if (containsSensitive(value)) return failed([issue("$", "Remove sensitive data before authoring")]);
  if (value.discovery.decision !== "author") return failed([issue("discovery.decision", "Reuse or configure the existing capability instead of scaffolding")]);
  const files = syntheticToolFiles(value.name);
  return {
    ok: true as const, schema_version: 1, kind: "inert_extension_scaffold",
    revision: digest({ name: value.name, goal: value.goal, discovery: value.discovery, files }),
    relative_staging_directory: `extension-drafts/${value.name}`,
    files, goal: value.goal, discovery: { ...value.discovery, provenance: "caller_supplied_not_verified" },
    surface: "external_tool", scope: "local_synthetic_service_template",
    validation: { status: "not_run", argv: ["--test", `${value.name}.test.cjs`], runtime: "process.execPath" },
    privileges: ["full_trust_import", "loopback_http_read"],
    execution_authorized: false, installation_authorized: false, publication_authorized: false,
    required_gates: ["scope_review", "code_execution", "exact_artifact_review", "installation", "agent_permission", "actual_capability_verification"],
  };
}

function patchLines(prefix: string, content: string | null) {
  if (content === null || content === "") return "";
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => `${prefix}${line}\n`).join("")
    + (content.endsWith("\n") ? "" : "\\ No newline at end of file\n");
}
function lineCount(content: string | null) {
  return content === null || content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}
function diffFile(entry: z.infer<typeof file>) {
  const before = lineCount(entry.before), after = lineCount(entry.after);
  return `diff --git a/${entry.path} b/${entry.path}\n`
    + (entry.before === null ? "new file mode 100644\n" : entry.after === null ? "deleted file mode 100644\n" : "")
    + `--- ${entry.before === null ? "/dev/null" : `a/${entry.path}`}\n`
    + `+++ ${entry.after === null ? "/dev/null" : `b/${entry.path}`}\n`
    + (before === 0 && after === 0 ? "" : `@@ -${before ? 1 : 0},${before} +${after ? 1 : 0},${after} @@\n`
      + patchLines("-", entry.before) + patchLines("+", entry.after));
}

export function prepareContributionBundle(input: unknown) {
  const parsed = parse(ContributionBundleInput, input);
  if (!parsed.success) return failed(parsed.issues);
  const value = parsed.data;
  const issues: Issue[] = [];
  if (value.worktree !== "clean") issues.push(issue("worktree", "Resolve or isolate dirty/unknown worktree changes first"));
  if (value.ownership === "unknown") issues.push(issue("ownership", "Establish contribution rights before bundling"));
  if (value.tests.status !== "passed") issues.push(issue("tests.status", "Passing test evidence is required; failing or unrun tests block the bundle"));
  if (containsSensitive(value)) issues.push(issue("$", "Sensitive content detected; remove it and review every outgoing byte"));
  const paths = new Set<string>();
  for (const [index, entry] of value.files.entries()) {
    const path = `files.${index}`;
    if (!/^[A-Za-z0-9_./-]+$/.test(entry.path) || sensitivePath.test(entry.path)) {
      issues.push(issue(`${path}.path`, "Unsupported or sensitive path; select portable source/documentation files only"));
    }
    const folded = entry.path.toLowerCase();
    if (paths.has(folded)) issues.push(issue(`${path}.path`, "Duplicate or case-colliding file path"));
    if ([...paths].some((existing) => existing.startsWith(`${folded}/`) || folded.startsWith(`${existing}/`))) {
      issues.push(issue(`${path}.path`, "File/directory path conflicts are not supported"));
    }
    paths.add(folded);
    if (entry.before === entry.after) issues.push(issue(path, "File must contain an actual change"));
    if (entry.before === "" && entry.after === null || entry.before === null && entry.after === "") {
      issues.push(issue(path, "Empty-file create/delete patches are not supported"));
    }
  }
  if (issues.length) return failed(issues);
  const files = [...value.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const diff = files.map(diffFile).join("");
  const manifest = { ...value, files };
  return {
    ok: true as const, schema_version: 1, kind: "local_contribution_review_bundle",
    revision: digest(manifest), destination: value.destination, branch: value.branch,
    base_revision: value.base_revision, classification: value.classification, summary: value.summary,
    files, diff,
    checks: {
      scope: "supplied_text_only", worktree: "caller_supplied_not_verified", tests: "caller_supplied_not_verified",
      ownership: "caller_supplied_not_verified", privacy: "heuristics_passed_human_review_required",
    },
    reported_tests: value.tests, ownership: value.ownership, license_review: value.license_review,
    publication_authorized: false, execution_authorized: false,
    required_gates: ["verify_repository_and_base", "verify_tests_and_rights", "human_privacy_review", "exact_diff_review", "commit", "push", "draft_pr"],
  };
}
