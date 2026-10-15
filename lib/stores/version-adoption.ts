import { execFileSync } from "node:child_process";
import { getMemory, putMemory } from "@/lib/stores/memory";
import { getDefaultAgentConfig } from "@/lib/stores/agent-configs";
import { getOrCreateAgentThread } from "@/lib/stores/threads";
import { getCurrentVersion } from "@/lib/lifecycle/version";
import {
  changesetsBetween,
  formatChangesetsForPrompt,
  summarizeChangesets,
  type ChangesetRange,
} from "@/lib/lifecycle/changesets";
import {
  completeWorkflow,
  mergeWorkflowProgress,
  type WorkflowItemStatus,
} from "@/lib/stores/workflow-progress";

const NAMESPACE = "app-lifecycle";
const STATE_KEY = "version_adoption_state";

export type VersionAdoptionStatus = "idle" | "pending" | "running" | "done" | "failed" | "dismissed" | "blocked_no_default_agent";
export type VersionAdoptionPhase = "impact_radius" | "adoption" | "complete" | null;
export type VersionAdoptionChecklistStatus = WorkflowItemStatus;
export type VersionAdoptionAction = "read_skill" | "review_permissions" | "review_schedule" | "review_watcher" | "read_instructions" | "review_tools" | "review_api" | "review_persistence" | "review_release";

export interface VersionAdoptionWorkflowProgressInput {
  phase?: VersionAdoptionPhase;
  item_id?: string;
  status?: VersionAdoptionChecklistStatus;
  validation_evidence?: string;
  summary?: string;
  error?: string | null;
}

export interface VersionAdoptionChecklistItem {
  id: string;
  label: string;
  input: string;
  output: string;
  validation: string;
  status: VersionAdoptionChecklistStatus;
  validation_evidence?: string;
  reason: string;
  affected_files: string[];
  action?: VersionAdoptionAction;
}

export interface VersionAdoptionState {
  current_version: string;
  previous_version: string | null;
  is_first_adoption: boolean;
  status: VersionAdoptionStatus;
  phase: VersionAdoptionPhase;
  default_agent_id: string | null;
  default_agent_name: string | null;
  adoption_thread_id: string | null;
  adoption_prompt: string | null;
  started_at: string | null;
  completed_at: string | null;
  dismissed_at: string | null;
  summary: string;
  checklist: VersionAdoptionChecklistItem[];
  stale_prompt_risks: string[];
  error: string | null;
}

type StoredVersionAdoptionState = VersionAdoptionState & {
  last_adopted_version: string | null;
};

/** A client request that cannot be applied to the current adoption state. */
export class VersionAdoptionRequestError extends Error {}

const DEFAULT_CHECKLIST: VersionAdoptionChecklistItem[] = [
  {
    id: "instructions",
    label: "Review instructions and skills",
    input: "Changed instruction, skill, and harness files, plus the current agent behavior they define.",
    output: "Findings and any required instruction or skill updates.",
    validation: "Read each affected file and verify findings against the active prompt/skill loading path.",
    status: "pending",
    reason: "Agent behavior may depend on changed repo instructions, built-in skills, or prompt guidance.",
    affected_files: [],
    action: "read_instructions",
  },
  {
    id: "tools",
    label: "Review tool and permission changes",
    input: "Changed tool implementations, registrations, descriptions, and permission rules.",
    output: "Findings and required tool or permission adoption actions.",
    validation: "Trace affected tools through registration and permission checks; run focused tests when available.",
    status: "pending",
    reason: "Tool descriptions, permissions, or package registrations can change how agents should act.",
    affected_files: [],
    action: "review_tools",
  },
  {
    id: "scheduled-work",
    label: "Review scheduled tasks and watchers",
    input: "Changed scheduler, watcher, trigger, and long-lived prompt behavior.",
    output: "Findings and required scheduled-work prompt updates.",
    validation: "Inspect affected scheduling paths and run relevant tests; report any unchecked behavior as unknown.",
    status: "pending",
    reason: "Long-lived prompts for scheduled tasks and watchers can become stale after runtime or tool changes.",
    affected_files: [],
    action: "review_schedule",
  },
];

const PHASE_1_CHECKLIST: VersionAdoptionChecklistItem[] = [
  {
    id: "fetch-changes",
    label: "Fetch changes",
    input: "Previously adopted version, current version, the bundled release changesets, and git history when running from a source checkout.",
    output: "The prompt and tool description/schema deltas from the release changesets, or the changed-file list from git, between the baseline and current version.",
    validation: "Use the system-computed changeset or git diff result; if no baseline is available, explicitly identify first-adoption status.",
    status: "pending",
    reason: "Compare the current version with the previously adopted version or baseline.",
    affected_files: [],
  },
  {
    id: "build-todo-list",
    label: "Build todo list",
    input: "System-computed change surface and classified adoption surfaces.",
    output: "A Phase 2 checklist covering all matched changes and a fallback review for unmatched changes.",
    validation: "Check that every changed prompt, tool, or path is represented by an adoption item or explicitly covered by the fallback.",
    status: "pending",
    reason: "Turn detected version changes into the concrete Phase 2 adoption checklist.",
    affected_files: [],
  },
];

function now(): string {
  return new Date().toISOString();
}

function parseStored(): StoredVersionAdoptionState | null {
  const row = getMemory(NAMESPACE, STATE_KEY);
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<StoredVersionAdoptionState>;
    if (typeof parsed.current_version !== "string") return null;
    return {
      current_version: parsed.current_version,
      previous_version: typeof parsed.previous_version === "string" ? parsed.previous_version : null,
      is_first_adoption: parsed.is_first_adoption === true,
      status: isStatus(parsed.status) ? parsed.status : "pending",
      phase: isPhase(parsed.phase) ? parsed.phase : null,
      default_agent_id: typeof parsed.default_agent_id === "string" ? parsed.default_agent_id : null,
      default_agent_name: typeof parsed.default_agent_name === "string" ? parsed.default_agent_name : null,
      adoption_thread_id: typeof parsed.adoption_thread_id === "string" ? parsed.adoption_thread_id : null,
      adoption_prompt: typeof parsed.adoption_prompt === "string" ? parsed.adoption_prompt : null,
      started_at: typeof parsed.started_at === "string" ? parsed.started_at : null,
      completed_at: typeof parsed.completed_at === "string" ? parsed.completed_at : null,
      dismissed_at: typeof parsed.dismissed_at === "string" ? parsed.dismissed_at : null,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      checklist: Array.isArray(parsed.checklist)
        ? parsed.checklist.map(normalizeChecklistItem).filter((item): item is VersionAdoptionChecklistItem => item !== null)
        : [],
      stale_prompt_risks: Array.isArray(parsed.stale_prompt_risks)
        ? parsed.stale_prompt_risks.filter((item): item is string => typeof item === "string")
        : [],
      error: typeof parsed.error === "string" ? parsed.error : null,
      last_adopted_version: typeof parsed.last_adopted_version === "string" ? parsed.last_adopted_version : null,
    };
  } catch {
    return null;
  }
}

function isStatus(value: unknown): value is VersionAdoptionStatus {
  return value === "idle" || value === "pending" || value === "running" || value === "done" || value === "failed" || value === "dismissed" || value === "blocked_no_default_agent";
}

function isPhase(value: unknown): value is VersionAdoptionPhase {
  return value === "impact_radius" || value === "adoption" || value === "complete" || value === null;
}

function normalizeChecklistItem(value: unknown): VersionAdoptionChecklistItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<VersionAdoptionChecklistItem>;
  if (typeof item.id !== "string" || typeof item.label !== "string" || typeof item.reason !== "string") return null;
  const validationEvidence = typeof item.validation_evidence === "string" && item.validation_evidence.trim()
    ? item.validation_evidence
    : undefined;
  const storedStatus = isChecklistStatus(item.status) ? item.status : "pending";
  const legacyCompletionNeedsReview = storedStatus === "done" && !validationEvidence;
  return {
    id: item.id,
    label: item.label,
    status: legacyCompletionNeedsReview ? "needs_attention" : storedStatus,
    reason: legacyCompletionNeedsReview
      ? `${item.reason} Previously stored completion had no validation evidence; review this step again.`
      : item.reason,
    affected_files: Array.isArray(item.affected_files)
      ? item.affected_files.filter((file): file is string => typeof file === "string")
      : [],
    input: typeof item.input === "string" ? item.input : "Previously stored workflow context and affected files.",
    output: typeof item.output === "string" ? item.output : "Review findings and any required adoption actions.",
    validation: typeof item.validation === "string"
      ? item.validation
      : "Verify findings against the affected files; report unavailable evidence instead of inferring.",
    ...(validationEvidence ? { validation_evidence: validationEvidence } : {}),
    ...(isVersionAdoptionAction(item.action) ? { action: item.action } : {}),
  };
}

function isChecklistStatus(value: unknown): value is VersionAdoptionChecklistStatus {
  return value === "pending" || value === "checking" || value === "done" || value === "needs_attention" || value === "skipped";
}

function isVersionAdoptionAction(value: unknown): value is VersionAdoptionAction {
  return value === "read_skill" || value === "review_permissions" || value === "review_schedule"
    || value === "review_watcher" || value === "read_instructions" || value === "review_tools"
    || value === "review_api" || value === "review_persistence" || value === "review_release";
}

function persist(state: StoredVersionAdoptionState): VersionAdoptionState {
  putMemory(NAMESPACE, STATE_KEY, state);
  return publicState(state);
}

function publicState(state: StoredVersionAdoptionState): VersionAdoptionState {
  const { last_adopted_version: _last, ...visible } = state;
  return visible;
}

function changedFiles(previousVersion: string | null, currentVersion: string): string[] {
  if (!previousVersion) return [];
  const tag = `v${previousVersion}`;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
    execFileSync("git", ["rev-parse", "--verify", tag], { stdio: "ignore" });
    const raw = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", `${tag}..HEAD`], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    void currentVersion;
    return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((file) => file.replace(/\\/g, "/"));
  } catch {
    return [];
  }
}

function filesMatching(files: readonly string[], patterns: readonly RegExp[]): string[] {
  return files.filter((file) => patterns.some((pattern) => pattern.test(file)));
}

function item(
  id: string,
  label: string,
  reason: string,
  input: string,
  output: string,
  validation: string,
  files: string[],
  action: VersionAdoptionAction,
): VersionAdoptionChecklistItem | null {
  if (files.length === 0) return null;
  return {
    id,
    label,
    input,
    output,
    validation,
    status: "pending",
    reason,
    affected_files: files.slice(0, 12),
    action,
  };
}

type ChangeSource = "changeset" | "git" | "none";

interface AdoptionPlan {
  items: VersionAdoptionChecklistItem[];
  source: ChangeSource;
  range: ChangesetRange | null;
}

function changesetChecklist(previousVersion: string, range: ChangesetRange): VersionAdoptionChecklistItem[] {
  const summary = summarizeChangesets(range.entries);
  const toolRefs = summary.toolNames.map((name) => `tool:${name}`);
  const promptRefs = summary.promptIds.map((id) => `prompt:${id}`);
  const removed = summary.removedTools.length > 0 ? ` Removed tools: ${summary.removedTools.join(", ")}.` : "";
  const items: VersionAdoptionChecklistItem[] = [];
  const surfaceItem = (
    entry: Omit<VersionAdoptionChecklistItem, "status" | "affected_files"> & { refs: string[] },
  ): VersionAdoptionChecklistItem => {
    const { refs, ...rest } = entry;
    return { ...rest, status: "pending", affected_files: refs.slice(0, 12) };
  };

  if (summary.toolNames.length > 0) {
    items.push(surfaceItem({
      id: "adapt-settings",
      label: "Adapt agent settings to tool changes",
      reason: `${summary.toolNames.length} built-in tool(s) changed description or schema since ${previousVersion}.${removed}`,
      input: "Release changeset tool deltas, every agent's configuration from read_agent_config (tool allowlist and delegate targets), and the live catalog from list_tools.",
      output: "Per agent: proposed settings edits for allowlists that reference removed tools or should include changed tools the user relies on, or an explicit no-change finding.",
      validation: "After approved edits, re-read each agent with read_agent_config and confirm every allowlisted tool name exists in list_tools; name every agent checked.",
      action: "review_permissions",
      refs: toolRefs,
    }));
  }
  if (summary.toolNames.length > 0 || summary.promptIds.length > 0) {
    items.push(surfaceItem({
      id: "adapt-task-prompts",
      label: "Adapt scheduled task and watcher prompts",
      reason: "Long-lived task and watcher prompts can reference changed tools or parameters, or repeat built-in guidance that changed.",
      input: "Release changeset tool and prompt deltas, plus every prompt returned by list_scheduled_tasks and list_watchers.",
      output: "For each affected task or watcher: current prompt, proposed prompt, and the changeset delta that motivates it; unaffected ones listed as checked.",
      validation: "After approved update_scheduled_task / update_watcher calls, re-list and confirm each stored prompt equals the approved text and names only tools present in list_tools.",
      action: "review_schedule",
      refs: [...toolRefs, ...promptRefs],
    }));
    items.push(surfaceItem({
      id: "adapt-instructions-skills",
      label: "Adapt agent instructions and skills",
      reason: "Agent instructions and user skills can reference changed tools or parameters, or duplicate or contradict changed built-in prompt guidance.",
      input: "Release changeset prompt and tool deltas, each agent's instructions from read_agent_instruction, and user skills from list_skills / read_skill.",
      output: "For each affected instruction or skill: before and after text and the changeset delta that motivates it; unaffected ones listed as checked.",
      validation: "After approved update_agent_instruction / write_skill calls, re-read each artifact and confirm the stored text matches and names only tools and parameters present in list_tools and the changed schemas.",
      action: "read_skill",
      refs: [...promptRefs, ...toolRefs],
    }));
  }
  if (summary.hints.length > 0) {
    items.push(surfaceItem({
      id: "release-hints",
      label: "Apply release adoption hints",
      reason: `The release notes include ${summary.hints.length} adoption hint(s) from the maintainers.`,
      input: `Adoption hints: ${summary.hints.join(" | ")}`,
      output: "Each hint applied to the user's setup, or a finding that it does not apply.",
      validation: "For each hint, cite the artifact or setting checked and re-read anything changed.",
      action: "review_release",
      refs: [],
    }));
  }
  if (!range.complete) {
    items.push(surfaceItem({
      id: "version-diff",
      label: "Review changes not covered by changesets",
      reason: `Bundled changesets do not fully cover ${previousVersion} → current; older releases predate changesets.`,
      input: "The available changesets and the changelog for the uncovered versions.",
      output: "Findings for uncovered versions and any required adoption actions.",
      validation: "State which versions were covered by changesets and which only by the changelog.",
      action: "review_release",
      refs: [],
    }));
  }
  if (items.length === 0) {
    items.push(surfaceItem({
      id: "version-diff",
      label: "Review version changes",
      reason: "Release changesets report no prompt or tool description/schema changes; user prompts, skills, and settings need no adaptation.",
      input: "Release changesets for the version range.",
      output: "Confirmation that no adaptation is required.",
      validation: "Confirm each changeset in the range lists no tool or prompt changes and no adoption hints.",
      action: "review_release",
      refs: [],
    }));
    items[0].status = "skipped";
  }
  return items;
}

function computeAdoptionPlan(previousVersion: string | null, currentVersion: string): AdoptionPlan {
  if (!previousVersion) {
    return { items: DEFAULT_CHECKLIST.map((entry) => ({ ...entry })), source: "none", range: null };
  }
  const range = changesetsBetween(previousVersion, currentVersion);
  if (range.entries.length > 0) {
    return { items: changesetChecklist(previousVersion, range), source: "changeset", range };
  }
  const files = changedFiles(previousVersion, currentVersion);
  return { items: gitChecklist(files), source: files.length > 0 ? "git" : "none", range: null };
}

function buildChecklist(previousVersion: string | null, currentVersion: string): VersionAdoptionChecklistItem[] {
  return computeAdoptionPlan(previousVersion, currentVersion).items;
}

function gitChecklist(files: readonly string[]): VersionAdoptionChecklistItem[] {
  const dynamic = [
    item(
      "permissions",
      "Review permissions and tool access",
      "Tool registration, category, package, or permission files changed since the last adopted version.",
      "Changed tool registration and permission files.",
      "Validated findings about capability exposure and any required permission changes.",
      "Inspect each affected file, trace the permission path, and run relevant tool/permission tests.",
      filesMatching(files, [/^lib\/tools\//, /^packages\/[^/]+-langchain\//, /^lib\/stores\/agent-configs\./, /^lib\/stores\/builtin-tools\./]),
      "review_permissions",
    ),
    item(
      "skills-instructions",
      "Review changed skills and instructions",
      "Agent instructions, skill files, or harness prompts changed and may affect behavior.",
      "Changed instruction, skill, and harness files plus their loading paths.",
      "Validated behavior impact and any required instruction or skill updates.",
      "Read each affected file and verify changes against the prompt/skill loading path.",
      filesMatching(files, [/^\.github\/skills\//, /^\.github\/instructions\//, /^\.github\/copilot-instructions\.md$/, /^lib\/skills\//, /^lib\/agents\/harness\//]),
      "read_skill",
    ),
    item(
      "scheduled-work",
      "Review scheduled tasks and watchers",
      "Scheduler, trigger, or watcher behavior changed and long-lived prompts may need review.",
      "Changed scheduler, trigger, watcher, and long-lived prompt files.",
      "Validated findings and any required scheduled-work prompt updates.",
      "Inspect each affected scheduling path and run its focused tests when available.",
      filesMatching(files, [/^lib\/scheduler\//, /^lib\/triggers\//, /^lib\/tools\/(schedule|watcher)\.ts$/]),
      "review_schedule",
    ),
    item(
      "stale-prompts",
      "Check stale prompt risks",
      "Agent prompt assembly or runtime policy changed since the last adopted version.",
      "Changed prompt assembly, harness, and runtime-policy files.",
      "Validated stale-prompt risks and specific corrective actions.",
      "Trace changed prompt code into the assembled prompt and test the affected behavior.",
      filesMatching(files, [/^lib\/agents\//, /^lib\/agents\/prepare\/system-prompt\.ts$/]),
      "read_instructions",
    ),
    item(
      "api-persistence",
      "Review API and persistence contracts",
      "API, database, or store changes can require migrations, docs, or client updates.",
      "Changed API schemas, database migrations, stores, and their clients.",
      "Validated contract impact and any required migration, client, or documentation actions.",
      "Check schema and migration compatibility, then run focused contract and persistence tests.",
      filesMatching(files, [/^app\/api\//, /^api\//, /^lib\/api\//, /^lib\/db\//, /^lib\/stores\//]),
      "review_api",
    ),
    item(
      "release-notes",
      "Review release notes and package metadata",
      "Release metadata changed and should describe user-visible behavior.",
      "Changed changelog, package metadata, and release configuration.",
      "Validated release notes and package/version metadata.",
      "Compare release notes with the actual diff and verify package metadata consistency.",
      filesMatching(files, [/^CHANGELOG\.md$/, /^package\.json$/, /^package-lock\.json$/, /^packages\/[^/]+\/package\.json$/, /^packages\/[^/]+\/CHANGELOG\.md$/]),
      "review_release",
    ),
  ].filter((entry): entry is VersionAdoptionChecklistItem => entry !== null);

  if (dynamic.length === 0) {
    return [{
      id: "version-diff",
      label: "Review version changes",
      input: "System-computed changed-file list and available changelog.",
      output: "Findings for unclassified changes and any required adoption actions.",
      validation: "Compare findings with the available changed-file list and changelog; state explicitly if either is unavailable.",
      status: files.length === 0 ? "skipped" : "pending",
      reason: files.length === 0
        ? "No git diff was available for the stored version; use the changelog as the fallback briefing."
        : "Changed files did not match a known ripple surface; review the changelog for user-visible behavior.",
      affected_files: files.slice(0, 12),
      action: "review_release",
    }];
  }
  return dynamic;
}

function phase1Checklist(): VersionAdoptionChecklistItem[] {
  return PHASE_1_CHECKLIST.map((entry) => ({ ...entry }));
}

// `fetch-changes` never needs an agent tool call: the changeset read or git
// diff it reports on already ran synchronously in createState() (via
// computeAdoptionPlan), so the item starts pre-completed with the
// deterministic result baked into its reason. Only `build-todo-list` is left
// for the agent to actually do.
function resolvedPhase1Checklist(
  plan: AdoptionPlan,
  isFirst: boolean,
): VersionAdoptionChecklistItem[] {
  const [fetchChanges, ...rest] = phase1Checklist();
  const adoptionChecklist = plan.items;
  const affectedCount = adoptionChecklist.reduce((n, entry) => n + entry.affected_files.length, 0);
  const changesetVersions = plan.range?.entries.map((entry) => entry.version).join(", ") ?? "";
  const evidence = isFirst
    ? "System confirmed that this is the first adoption and no prior baseline exists."
    : plan.source === "changeset"
      ? `System read bundled release changesets for ${changesetVersions}${plan.range?.complete ? "" : " (partial coverage)"}; ${affectedCount} changed prompt/tool surface reference(s) were counted.`
      : `System computed the changed-file surface against the prior version; ${affectedCount} affected file(s) were counted.`;
  const reason = isFirst
    ? "First adoption — no previously adopted version to diff against."
    : plan.source === "changeset"
      ? `Read deterministically from the bundled release changesets (prompt and tool description/schema deltas): ${affectedCount} surface reference(s) across ${adoptionChecklist.length} area(s).`
      : `Computed deterministically via git diff against the previously adopted version: ${affectedCount} affected file(s) across ${adoptionChecklist.length} area(s).`;
  return [
    {
      ...fetchChanges,
      status: "done",
      validation_evidence: evidence,
      reason,
    },
    ...rest,
  ];
}

function stalePromptRisks(checklist: readonly VersionAdoptionChecklistItem[]): string[] {
  return checklist
    .filter((item) => item.id === "skills-instructions" || item.id === "scheduled-work" || item.id === "stale-prompts" || item.id === "permissions"
      || item.id === "adapt-settings" || item.id === "adapt-task-prompts" || item.id === "adapt-instructions-skills")
    .map((item) => item.label);
}

function buildSummary(state: Pick<VersionAdoptionState, "current_version" | "previous_version" | "is_first_adoption">, checklist: readonly VersionAdoptionChecklistItem[]): string {
  if (state.is_first_adoption) {
    return `Current version ${state.current_version} baseline is ready; review current guidance before relying on long-lived prompts.`;
  }
  return `Version ${state.current_version} has ${checklist.length} adoption check${checklist.length === 1 ? "" : "s"} from ${state.previous_version}.`;
}

function buildAdoptionPrompt(state: Pick<VersionAdoptionState, "current_version" | "previous_version" | "is_first_adoption" | "summary" | "checklist" | "stale_prompt_risks">): string {
  const phaseLabel = state.is_first_adoption
    ? `current-version baseline ${state.current_version}`
    : `upgrade from ${state.previous_version} to ${state.current_version}`;
  const plan = computeAdoptionPlan(state.previous_version, state.current_version);
  const changesetSection = plan.source === "changeset" && plan.range
    ? [
      "",
      `Release changesets — model-facing prompt and tool description/schema changes from ${state.previous_version} to ${state.current_version}${plan.range.complete ? "" : " (partial: older versions predate changesets)"}:`,
      formatChangesetsForPrompt(plan.range.entries),
    ]
    : [];
  return [
    `Run Jarela version adoption for ${phaseLabel}.`,
    "",
    "Phase 1 — impact radius analysis:",
    plan.source === "changeset"
      ? "- The change surface (`fetch-changes`) was already read deterministically by the system from the bundled release changesets: prompt text and built-in tool description/schema deltas between the previously adopted version and this one. They are listed under \"Release changesets\" below. Do not independently fetch or guess at what changed; that item is already marked done in the UI."
      : "- The changed-file surface (`fetch-changes`) was already computed deterministically by the system via git diff against the previously adopted version — see each Phase 2 checklist item below with its affected_files. Do not independently fetch or guess at what changed; that item is already marked done in the UI.",
    "- Every checklist item provides its input, expected output, and validation criteria. Work from the stated inputs, validate the output using those criteria, and report observed evidence before marking the item done.",
    "- Prefer executable checks for code-verifiable behavior. If a check cannot run, say why and leave the result unverified or mark the item needs_attention.",
    "- Call `workflow_progress` with `workflow_id: \"version_adoption\"`, `phase: \"impact_radius\"`, `item_id: \"build-todo-list\"`, and `status: \"checking\"`.",
    "- Build the Phase 2 todo list from the adoption checklist below, deciding which items are actionable, skipped, or need attention.",
    "- Then call `workflow_progress` for `item_id: \"build-todo-list\"` with `status: \"done\"` and `validation_evidence` containing the observed coverage check.",
    "",
    "Phase 2 — adoption:",
    "- Start Phase 2 by calling `workflow_progress` with `workflow_id: \"version_adoption\"` and `phase: \"adoption\"`; the UI will swap from the Phase 1 checklist to the generated adoption todo list.",
    "- Before each Phase 2 checklist item, call `workflow_progress` with that `item_id` and `status: \"checking\"`.",
    "- If Phase 1 finds actionable adoption work, complete safe local updates directly when your available tools allow it.",
    "- For `adapt-*` items, compare each user artifact (agent settings, instructions, skills, scheduled task and watcher prompts) with the release changesets: removed tools, added, removed, or newly required parameters, changed tool descriptions, and built-in prompt guidance the artifact now duplicates or contradicts. Show the before and after text, apply an edit only after the user approves it, then re-read the artifact to validate.",
    "- For risky or external side effects, propose an approval flow instead of acting silently.",
    "- If Phase 1 finds no adoption work, explicitly say that Phase 2 is skipped and why.",
    "- After each Phase 2 item, call `workflow_progress` with `status: \"done\"` and observed `validation_evidence`, or `status: \"skipped\"` / `status: \"needs_attention\"` as appropriate.",
    "- Before your final response, call `workflow_progress` with `workflow_id: \"version_adoption\"`, `phase: \"complete\"`, and a concise `summary`.",
    "",
    "Constraints:",
    "- Do not create external issues, PRs, scheduled tasks, watcher updates, or credential changes unless the user explicitly approves.",
    "- Keep the response concise: what changed, what you checked, what was adopted, what was skipped, and any approval needed.",
    "",
    `Summary: ${state.summary}`,
    "Phase 1 checklist:",
    ...PHASE_1_CHECKLIST.map((item) => `- ${item.id}: ${item.label} — Input: ${item.input} Output: ${item.output} Validation: ${item.validation} Reason: ${item.reason}`),
    "Phase 2 adoption checklist:",
    ...plan.items.map((item) => `- ${item.id}: ${item.label}: Input: ${item.input} Output: ${item.output} Validation: ${item.validation} Reason: ${item.reason}${item.affected_files.length > 0 ? ` Affected: ${item.affected_files.join(", ")}.` : ""}`),
    state.stale_prompt_risks.length > 0 ? `Stale-prompt risks: ${state.stale_prompt_risks.join(", ")}.` : "Stale-prompt risks: none detected in the checklist.",
    ...changesetSection,
  ].join("\n");
}

function buildAdoptionStepRetryPrompt(
  state: Pick<VersionAdoptionState, "current_version" | "previous_version" | "is_first_adoption">,
  phase: "impact_radius" | "adoption",
  entry: VersionAdoptionChecklistItem,
): string {
  const phaseLabel = state.is_first_adoption
    ? `current-version baseline ${state.current_version}`
    : `upgrade from ${state.previous_version} to ${state.current_version}`;
  const plan = computeAdoptionPlan(state.previous_version, state.current_version);
  const changesetSection = phase === "adoption" && plan.source === "changeset" && plan.range
    ? ["", "Release changesets:", formatChangesetsForPrompt(plan.range.entries)]
    : [];
  return [
    `Retry one Jarela version adoption step for ${phaseLabel}. The user asked to redo only this step; leave every other checklist item unchanged.`,
    "",
    `Step: ${entry.id} — ${entry.label}`,
    `Input: ${entry.input}`,
    `Output: ${entry.output}`,
    `Validation: ${entry.validation}`,
    `Reason: ${entry.reason}`,
    ...(entry.affected_files.length > 0 ? [`Affected: ${entry.affected_files.join(", ")}.`] : []),
    "",
    `- Call \`workflow_progress\` with \`workflow_id: "version_adoption"\`, \`phase: "${phase}"\`, \`item_id: "${entry.id}"\`, and \`status: "checking"\`.`,
    "- Redo the step from its stated input. Prefer executable checks for code-verifiable behavior, and do not reuse earlier evidence: run the validation again.",
    `- Then call \`workflow_progress\` for \`item_id: "${entry.id}"\` with \`status: "done"\` and newly observed \`validation_evidence\`, or \`status: "needs_attention"\` with the reason.`,
    "- For `adapt-*` steps, show the before and after text and apply an edit only after the user approves it, then re-read the artifact.",
    "- Do not create external issues, PRs, scheduled tasks, watcher updates, or credential changes unless the user explicitly approves.",
    "- Keep the response concise: what you rechecked, the observed result, and any approval needed.",
    ...changesetSection,
  ].join("\n");
}

function retryAdoptionItem(
  state: StoredVersionAdoptionState,
  checklist: VersionAdoptionChecklistItem[],
  itemId: string,
  t: string,
): StoredVersionAdoptionState {
  const index = checklist.findIndex((entry) => entry.id === itemId);
  if (index === -1) throw new VersionAdoptionRequestError(`Unknown adoption checklist item: ${itemId}`);
  if (itemId === "fetch-changes") {
    throw new VersionAdoptionRequestError("fetch-changes is computed by the system and cannot be retried by the agent.");
  }
  if (!state.default_agent_id) {
    return { ...state, status: "blocked_no_default_agent", phase: null, error: "No default agent is configured." };
  }
  const phase = PHASE_1_CHECKLIST.some((entry) => entry.id === itemId) ? "impact_radius" : "adoption";
  const { validation_evidence: _previousEvidence, ...rest } = checklist[index];
  checklist[index] = { ...rest, status: "checking" };
  const thread = getOrCreateAgentThread(state.default_agent_id);
  return {
    ...state,
    status: "running",
    phase,
    started_at: state.started_at ?? t,
    completed_at: null,
    dismissed_at: null,
    checklist,
    adoption_thread_id: thread.thread_id,
    adoption_prompt: buildAdoptionStepRetryPrompt(state, phase, checklist[index]),
    error: null,
  };
}

function createState(currentVersion: string, previousVersion: string | null): StoredVersionAdoptionState {
  const defaultAgent = getDefaultAgentConfig();
  const isFirst = previousVersion === null;
  const plan = computeAdoptionPlan(previousVersion, currentVersion);
  const adoptionChecklist = plan.items;
  const summaryInput = {
    current_version: currentVersion,
    previous_version: previousVersion,
    is_first_adoption: isFirst,
  };
  return {
    current_version: currentVersion,
    previous_version: previousVersion,
    is_first_adoption: isFirst,
    status: defaultAgent ? "pending" : "blocked_no_default_agent",
    phase: null,
    default_agent_id: defaultAgent?.id ?? null,
    default_agent_name: defaultAgent?.name ?? null,
    adoption_thread_id: null,
    adoption_prompt: null,
    started_at: null,
    completed_at: null,
    dismissed_at: null,
    checklist: resolvedPhase1Checklist(plan, isFirst),
    stale_prompt_risks: stalePromptRisks(adoptionChecklist),
    summary: buildSummary(summaryInput, adoptionChecklist),
    error: defaultAgent ? null : "No default agent is configured.",
    last_adopted_version: previousVersion,
  };
}

export function getVersionAdoptionState(currentVersion = getCurrentVersion()): VersionAdoptionState {
  const stored = parseStored();
  if (!stored) return persist(createState(currentVersion, null));
  if (stored.current_version === currentVersion) {
    if (stored.status === "blocked_no_default_agent" && getDefaultAgentConfig()) {
      return persist(createState(currentVersion, stored.previous_version));
    }
    return publicState(stored);
  }

  const previousVersion = stored.last_adopted_version ?? stored.current_version;
  return persist(createState(currentVersion, previousVersion));
}

export function updateVersionAdoptionState(
  action: "start" | "mark_done" | "dismiss" | "retry",
  currentVersion = getCurrentVersion(),
  itemId?: string,
): VersionAdoptionState {
  const existing = parseStored();
  const state = existing && existing.current_version === currentVersion
    ? existing
    : createState(currentVersion, existing?.last_adopted_version ?? existing?.current_version ?? null);
  const t = now();
  const nextChecklist = state.checklist.map((entry) => ({ ...entry }));

  if (action === "retry" && itemId) {
    return persist(retryAdoptionItem(state, nextChecklist, itemId, t));
  }

  if (action === "start" || action === "retry") {
    if (!state.default_agent_id) {
      return persist({
        ...state,
        status: "blocked_no_default_agent",
        phase: null,
        error: "No default agent is configured.",
      });
    }
    const thread = getOrCreateAgentThread(state.default_agent_id);
    // fetch-changes is pre-completed at createState() time; mark the next
    // still-open item (normally build-todo-list) as checking instead of
    // hardcoding index 0, which would otherwise clobber that done status.
    const firstOpen = nextChecklist.findIndex((entry) => entry.status !== "done" && entry.status !== "skipped");
    if (firstOpen !== -1) nextChecklist[firstOpen].status = "checking";
    const running = {
      ...state,
      status: "running",
      phase: "impact_radius",
      started_at: state.started_at ?? t,
      completed_at: null,
      dismissed_at: null,
      checklist: nextChecklist,
      adoption_thread_id: thread.thread_id,
      error: null,
    } satisfies StoredVersionAdoptionState;
    return persist({ ...running, adoption_prompt: buildAdoptionPrompt(running) });
  }

  if (action === "mark_done") {
    const completed = completeWorkflow(
      { ...state, checklist: nextChecklist },
      "complete",
      "The user explicitly confirmed completion through the adoption checklist.",
    );
    return persist({
      ...completed,
      status: "done",
      completed_at: t,
      dismissed_at: null,
      adoption_prompt: null,
      error: null,
      last_adopted_version: currentVersion,
    });
  }

  return persist({
    ...state,
    status: "dismissed",
    phase: "complete",
    completed_at: state.completed_at ?? t,
    dismissed_at: t,
    adoption_prompt: null,
    error: null,
    last_adopted_version: currentVersion,
  });
}

export function recordVersionAdoptionWorkflowProgress(
  update: VersionAdoptionWorkflowProgressInput,
  currentVersion = getCurrentVersion(),
): { state: VersionAdoptionState; updated_item_id: string | null } {
  const existing = parseStored();
  const state = existing && existing.current_version === currentVersion
    ? existing
    : createState(currentVersion, existing?.last_adopted_version ?? existing?.current_version ?? null);
  const enteringAdoption = update.phase === "adoption" && state.phase !== "adoption";
  const baseState = enteringAdoption
    ? { ...state, phase: "adoption" as const, checklist: buildChecklist(state.previous_version, currentVersion) }
    : state;
  const result = mergeWorkflowProgress(baseState, update);
  if (result.state.phase === "complete" && result.state.checklist.some((entry) => (
    entry.status !== "done" && entry.status !== "skipped"
  ) || (entry.status === "done" && !entry.validation_evidence))) {
    throw new Error("Version adoption cannot be completed until every checklist item is validated or skipped.");
  }
  const completedPhase1Todo =
    result.state.phase === "impact_radius" &&
    update.item_id === "build-todo-list" &&
    update.status === "done";
  const progressed = completedPhase1Todo
    ? { ...result.state, phase: "adoption" as const, checklist: buildChecklist(state.previous_version, currentVersion) }
    : result.state;
  const nextStatus: VersionAdoptionStatus = result.state.phase === "complete"
    ? "done"
    : state.status === "done" || state.status === "dismissed"
      ? state.status
      : "running";
  const next = persist({
    ...progressed,
    status: nextStatus,
    started_at: state.started_at ?? now(),
    completed_at: progressed.phase === "complete" ? (state.completed_at ?? now()) : null,
    dismissed_at: null,
    adoption_prompt: progressed.phase === "complete" ? null : progressed.adoption_prompt,
    error: update.error !== undefined ? update.error : progressed.error,
    last_adopted_version: progressed.phase === "complete" ? currentVersion : state.last_adopted_version,
  });
  return { state: next, updated_item_id: result.updated_item_id };
}
