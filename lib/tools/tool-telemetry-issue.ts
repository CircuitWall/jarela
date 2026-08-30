import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createHash } from "node:crypto";
import { registerLangChainPackage } from "./langchain-package";
import {
  getToolStatsMap,
  listToolFailureSamples,
  type ToolFailureSampleRow,
  type ToolUsefulnessStats,
} from "@/lib/stores/tool-stats";
import { isCategoryEnabled } from "@/lib/stores/builtin-tools";
import { getMemory, putMemory } from "@/lib/stores/memory";
import { getFingerprint, recordSeen } from "@/lib/stores/change-tracker";
import { errorMessage } from "@/lib/utils/error";

const DEFAULT_OWNER = "CircuitWall";
const DEFAULT_REPO = "jarela";
const MAX_BODY_CHARS = 20_000;
const AUTO_NAMESPACE = "tool-telemetry-issues";
const AUTO_STATE_KEY = "auto-file";
const AUTO_FINGERPRINT_SCOPE = "tool-telemetry-issues";
const AUTO_FINGERPRINT_KEY = "last-filed";
const AUTO_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface TelemetryIssueInput {
  tool_names?: string[];
  min_calls?: number;
  max_tools?: number;
  include_successful?: boolean;
  title?: string;
  create_issue?: boolean;
  labels?: string[];
}

interface TelemetryToolRow {
  name: string;
  stats: ToolUsefulnessStats;
  failures: ToolFailureSampleRow[];
}

export function buildToolTelemetryComplaintIssue(input: TelemetryIssueInput = {}) {
  const requestedNames = normalizeNames(input.tool_names ?? []);
  const minCalls = Math.max(0, Math.floor(input.min_calls ?? 1));
  const maxTools = Math.min(50, Math.max(1, Math.floor(input.max_tools ?? 10)));
  const statsMap = getToolStatsMap(requestedNames.length > 0 ? requestedNames : undefined);
  const failureSamples = listToolFailureSamples();
  const failuresByTool = new Map<string, ToolFailureSampleRow[]>();
  for (const sample of failureSamples) {
    const rows = failuresByTool.get(sample.tool_name) ?? [];
    rows.push(sample);
    failuresByTool.set(sample.tool_name, rows);
  }

  const candidateNames = requestedNames.length > 0
    ? requestedNames
    : [...new Set([...statsMap.keys(), ...failureSamples.map((sample) => sample.tool_name)])];

  const rows = candidateNames
    .map((name): TelemetryToolRow => ({
      name,
      stats: statsMap.get(name) ?? emptyStats(),
      failures: failuresByTool.get(name) ?? [],
    }))
    .filter((row) => row.stats.call_count >= minCalls || row.failures.length > 0)
    .filter((row) => input.include_successful === true || row.stats.error_count > 0 || row.stats.score < 0.85 || row.failures.length > 0)
    .sort(compareTelemetryRows)
    .slice(0, maxTools);

  const title = input.title?.trim() || defaultIssueTitle(rows);
  const body = truncateBody(renderIssueBody(rows, { requestedNames, minCalls, includeSuccessful: input.include_successful === true }));
  const tools = rows.map((row) => row.name);
  return { title, body, tools, tool_count: rows.length, fingerprint: fingerprintIssue(title, body, tools) };
}

export async function createToolTelemetryGitHubIssue(input: {
  title: string;
  body: string;
  labels?: string[];
}) {
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (!token) {
    return {
      ok: false,
      error: "GitHub token not configured. Set GITHUB_TOKEN or GH_TOKEN, or file the returned draft manually.",
    };
  }
  const payload: Record<string, unknown> = { title: input.title, body: input.body };
  if (input.labels?.length) payload.labels = input.labels;
  const res = await fetch(`https://api.github.com/repos/${DEFAULT_OWNER}/${DEFAULT_REPO}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jarela-tool-telemetry",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  const data = parseJsonSafe(text);
  if (!res.ok) {
    return { ok: false, error: `GitHub ${res.status}: ${text.slice(0, 500)}` };
  }
  return {
    ok: true,
    number: typeof data.number === "number" ? data.number : null,
    url: typeof data.html_url === "string" ? data.html_url : null,
  };
}

export const reportToolTelemetryIssueTool = tool(
  async (input) => {
    const issue = buildToolTelemetryComplaintIssue(input);
    if (input.create_issue === true) {
      const created = await createToolTelemetryGitHubIssue({
        title: issue.title,
        body: issue.body,
        labels: input.labels,
      });
      return JSON.stringify({ ...created, issue });
    }
    return JSON.stringify({
      ok: true,
      created: false,
      owner: DEFAULT_OWNER,
      repo: DEFAULT_REPO,
      issue,
      hint: "Review the draft with the user. Call again with create_issue=true to file it when the user approves and GitHub auth is configured.",
    });
  },
  {
    name: "report_tool_telemetry_issue",
    description:
      "Summarize Jarela tool telemetry across one or more tools and produce a GitHub issue draft for CircuitWall/jarela. " +
      "Uses success rate, usefulness rate, failure counts, and sanitized failure scenarios. By default this only drafts; set create_issue=true after user approval to file the issue when GITHUB_TOKEN or GH_TOKEN is configured.",
    schema: z.object({
      tool_names: z.array(z.string()).optional().describe("Optional tool names to report. Omit to include the worst tools by telemetry."),
      min_calls: z.number().int().min(0).max(1000).optional().describe("Minimum call count for tools without failure samples. Default 1."),
      max_tools: z.number().int().min(1).max(50).optional().describe("Maximum tools to include. Default 10."),
      include_successful: z.boolean().optional().describe("Include healthy/successful tools too. Default false."),
      title: z.string().min(1).max(120).optional().describe("Optional issue title override."),
      create_issue: z.boolean().optional().describe("When true, create the GitHub issue in CircuitWall/jarela. Default false."),
      labels: z.array(z.string()).optional().describe("Optional existing GitHub label names to apply when create_issue=true."),
    }),
  },
);

export interface AutoToolTelemetryIssueResult {
  skipped: boolean;
  reason?: string;
  issue?: ReturnType<typeof buildToolTelemetryComplaintIssue>;
  github?: Awaited<ReturnType<typeof createToolTelemetryGitHubIssue>>;
}

export async function maybeAutoFileToolTelemetryIssue(nowDate = new Date()): Promise<AutoToolTelemetryIssueResult> {
  if (!isCategoryEnabled("Config")) return { skipped: true, reason: "tool_category_disabled" };
  if (!githubTokenConfigured()) return { skipped: true, reason: "github_token_missing" };
  if (!autoTelemetryDue(nowDate)) return { skipped: true, reason: "not_due" };

  const issue = buildToolTelemetryComplaintIssue({ max_tools: 20 });
  writeAutoTelemetryState({ last_checked_at: nowDate.toISOString(), next_run_at: new Date(nowDate.getTime() + AUTO_INTERVAL_MS).toISOString() });
  if (issue.tool_count === 0) return { skipped: true, reason: "no_matching_telemetry", issue };
  if (getFingerprint(AUTO_FINGERPRINT_SCOPE, AUTO_FINGERPRINT_KEY) === issue.fingerprint) {
    return { skipped: true, reason: "already_filed", issue };
  }

  const github = await createToolTelemetryGitHubIssue({
    title: issue.title,
    body: issue.body,
    labels: ["bug", "telemetry"],
  });
  if (github.ok) recordSeen(AUTO_FINGERPRINT_SCOPE, AUTO_FINGERPRINT_KEY, issue.fingerprint);
  return { skipped: !github.ok, reason: github.ok ? undefined : "github_create_failed", issue, github };
}

function autoTelemetryDue(nowDate: Date): boolean {
  const state = readAutoTelemetryState();
  if (!state?.next_run_at) return true;
  const nextMs = Date.parse(state.next_run_at);
  return !Number.isFinite(nextMs) || nextMs <= nowDate.getTime();
}

function readAutoTelemetryState(): { last_checked_at?: string; next_run_at?: string } | null {
  const row = getMemory(AUTO_NAMESPACE, AUTO_STATE_KEY);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as { last_checked_at?: string; next_run_at?: string }
      : null;
  } catch (err) {
    console.warn("[tool-telemetry] failed to parse auto filing state:", errorMessage(err));
    return null;
  }
}

function writeAutoTelemetryState(state: { last_checked_at: string; next_run_at: string }): void {
  putMemory(AUTO_NAMESPACE, AUTO_STATE_KEY, state);
}

function normalizeNames(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

function compareTelemetryRows(a: TelemetryToolRow, b: TelemetryToolRow): number {
  const severity = telemetrySeverity(b) - telemetrySeverity(a);
  if (severity !== 0) return severity;
  return a.name.localeCompare(b.name);
}

function telemetrySeverity(row: TelemetryToolRow): number {
  const calls = Math.max(1, row.stats.call_count);
  const errorRate = row.stats.error_count / calls;
  return (errorRate * 100) + ((1 - row.stats.success_rate) * 40) + ((1 - row.stats.score) * 25) + row.failures.reduce((sum, f) => sum + f.count, 0);
}

function defaultIssueTitle(rows: readonly TelemetryToolRow[]): string {
  if (rows.length === 0) return "Tool telemetry complaint: no matching failures found";
  if (rows.length === 1) return `Tool telemetry complaint: ${rows[0].name}`;
  return `Tool telemetry complaint: ${rows.length} tools need attention`;
}

function renderIssueBody(
  rows: readonly TelemetryToolRow[],
  opts: { requestedNames: readonly string[]; minCalls: number; includeSuccessful: boolean },
): string {
  const lines = [
    "## Summary",
    "",
    "Automated complaint generated from local Jarela tool telemetry.",
    "",
    "## Query",
    "",
    `- requested tools: ${opts.requestedNames.length > 0 ? opts.requestedNames.join(", ") : "worst tools by telemetry"}`,
    `- min_calls: ${opts.minCalls}`,
    `- include_successful: ${opts.includeSuccessful}`,
    "",
    "## Affected tools",
    "",
  ];

  if (rows.length === 0) {
    lines.push("No matching tool failures or low-score telemetry were found.");
    return lines.join("\n");
  }

  for (const row of rows) {
    lines.push(`### ${row.name}`);
    lines.push("");
    lines.push(`- calls: ${row.stats.call_count}`);
    lines.push(`- success rate: ${formatPercent(row.stats.success_rate)}`);
    lines.push(`- usefulness rate: ${formatPercent(row.stats.usefulness_rate)}`);
    lines.push(`- score: ${formatPercent(row.stats.score)}`);
    lines.push(`- errors: ${row.stats.error_count}`);
    lines.push(`- last called: ${row.stats.last_called_at ?? "never"}`);
    if (row.failures.length > 0) {
      lines.push("", "Failure scenarios:");
      for (const failure of row.failures.slice(0, 5)) {
        lines.push(`- ${failure.normalized_reason} (${failure.count}x, last ${failure.last_seen_at})`);
        lines.push(`  - sample error: ${failure.sample_error}`);
        lines.push(`  - argument shape: ${failure.sample_arg_shape}`);
      }
    }
    lines.push("");
  }
  lines.push("## Expected follow-up", "", "Investigate whether these tools need better validation, clearer errors, retries, credential guidance, or implementation fixes.");
  return lines.join("\n");
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function truncateBody(body: string): string {
  if (body.length <= MAX_BODY_CHARS) return body;
  return `${body.slice(0, MAX_BODY_CHARS - 80)}\n\n_Trimmed to ${MAX_BODY_CHARS} characters._`;
}

function fingerprintIssue(title: string, body: string, tools: readonly string[]): string {
  return createHash("sha256")
    .update(title)
    .update("\0")
    .update(body)
    .update("\0")
    .update([...tools].sort().join("\n"))
    .digest("hex");
}

function githubTokenConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim());
}

function parseJsonSafe(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function emptyStats(): ToolUsefulnessStats {
  return {
    call_count: 0,
    success_count: 0,
    error_count: 0,
    used_count: 0,
    success_rate: 1,
    usefulness_rate: 1,
    score: 1,
    never_used: true,
    last_called_at: null,
  };
}

registerLangChainPackage({
  category: "Config",
  tools: { write: [reportToolTelemetryIssueTool] },
});