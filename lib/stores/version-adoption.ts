import { execFileSync } from "node:child_process";
import { getMemory, putMemory } from "@/lib/stores/memory";
import { getDefaultAgentConfig } from "@/lib/stores/agent-configs";
import { getOrCreateAgentThread } from "@/lib/stores/threads";
import { getCurrentVersion } from "@/lib/lifecycle/version";
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
  summary?: string;
  error?: string | null;
}

export interface VersionAdoptionChecklistItem {
  id: string;
  label: string;
  status: VersionAdoptionChecklistStatus;
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

const DEFAULT_CHECKLIST: VersionAdoptionChecklistItem[] = [
  {
    id: "instructions",
    label: "Review instructions and skills",
    status: "pending",
    reason: "Agent behavior may depend on changed repo instructions, built-in skills, or prompt guidance.",
    affected_files: [],
    action: "read_instructions",
  },
  {
    id: "tools",
    label: "Review tool and permission changes",
    status: "pending",
    reason: "Tool descriptions, permissions, or package registrations can change how agents should act.",
    affected_files: [],
    action: "review_tools",
  },
  {
    id: "scheduled-work",
    label: "Review scheduled tasks and watchers",
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
    status: "pending",
    reason: "Compare the current version with the previously adopted version or baseline.",
    affected_files: [],
  },
  {
    id: "build-todo-list",
    label: "Build todo list",
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
      checklist: Array.isArray(parsed.checklist) ? parsed.checklist.filter(isChecklistItem) : [],
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

function isChecklistItem(value: unknown): value is VersionAdoptionChecklistItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<VersionAdoptionChecklistItem>;
  return typeof item.id === "string" && typeof item.label === "string" && typeof item.reason === "string";
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
  files: string[],
  action: VersionAdoptionAction,
): VersionAdoptionChecklistItem | null {
  if (files.length === 0) return null;
  return { id, label, status: "pending", reason, affected_files: files.slice(0, 12), action };
}

function buildChecklist(previousVersion: string | null, currentVersion: string): VersionAdoptionChecklistItem[] {
  if (!previousVersion) {
    return DEFAULT_CHECKLIST.map((entry) => ({ ...entry }));
  }

  const files = changedFiles(previousVersion, currentVersion);
  const dynamic = [
    item(
      "permissions",
      "Review permissions and tool access",
      "Tool registration, category, package, or permission files changed since the last adopted version.",
      filesMatching(files, [/^lib\/tools\//, /^packages\/[^/]+-langchain\//, /^lib\/stores\/agent-configs\./, /^lib\/stores\/builtin-tools\./]),
      "review_permissions",
    ),
    item(
      "skills-instructions",
      "Review changed skills and instructions",
      "Agent instructions, skill files, or harness prompts changed and may affect behavior.",
      filesMatching(files, [/^\.github\/skills\//, /^\.github\/instructions\//, /^\.github\/copilot-instructions\.md$/, /^lib\/skills\//, /^lib\/agents\/harness\//]),
      "read_skill",
    ),
    item(
      "scheduled-work",
      "Review scheduled tasks and watchers",
      "Scheduler, trigger, or watcher behavior changed and long-lived prompts may need review.",
      filesMatching(files, [/^lib\/scheduler\//, /^lib\/triggers\//, /^lib\/tools\/(schedule|watcher)\.ts$/]),
      "review_schedule",
    ),
    item(
      "stale-prompts",
      "Check stale prompt risks",
      "Agent prompt assembly or runtime policy changed since the last adopted version.",
      filesMatching(files, [/^lib\/agents\//, /^lib\/agents\/prepare\/system-prompt\.ts$/]),
      "read_instructions",
    ),
    item(
      "api-persistence",
      "Review API and persistence contracts",
      "API, database, or store changes can require migrations, docs, or client updates.",
      filesMatching(files, [/^app\/api\//, /^api\//, /^lib\/api\//, /^lib\/db\//, /^lib\/stores\//]),
      "review_api",
    ),
    item(
      "release-notes",
      "Review release notes and package metadata",
      "Release metadata changed and should describe user-visible behavior.",
      filesMatching(files, [/^CHANGELOG\.md$/, /^package\.json$/, /^package-lock\.json$/, /^packages\/[^/]+\/package\.json$/, /^packages\/[^/]+\/CHANGELOG\.md$/]),
      "review_release",
    ),
  ].filter((entry): entry is VersionAdoptionChecklistItem => entry !== null);

  if (dynamic.length === 0) {
    return [{
      id: "version-diff",
      label: "Review version changes",
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

function stalePromptRisks(checklist: readonly VersionAdoptionChecklistItem[]): string[] {
  return checklist
    .filter((item) => item.id === "skills-instructions" || item.id === "scheduled-work" || item.id === "stale-prompts" || item.id === "permissions")
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
  return [
    `Run Jarela version adoption for ${phaseLabel}.`,
    "",
    "Phase 1 — impact radius analysis:",
    "- First, call `workflow_progress` with `workflow_id: \"version_adoption\"`, `phase: \"impact_radius\"`, `item_id: \"fetch-changes\"`, and `status: \"checking\"`.",
    "- Fetch or infer the changed surface from the provided version summary, changelog, and available repo context.",
    "- Then call `workflow_progress` for `item_id: \"fetch-changes\"` with `status: \"done\"` or `status: \"needs_attention\"`.",
    "- Next call `workflow_progress` for `item_id: \"build-todo-list\"` with `status: \"checking\"`.",
    "- Build the Phase 2 todo list from the adoption checklist below, deciding which items are actionable, skipped, or need attention.",
    "- Then call `workflow_progress` for `item_id: \"build-todo-list\"` with `status: \"done\"`.",
    "",
    "Phase 2 — adoption:",
    "- Start Phase 2 by calling `workflow_progress` with `workflow_id: \"version_adoption\"` and `phase: \"adoption\"`; the UI will swap from the Phase 1 checklist to the generated adoption todo list.",
    "- Before each Phase 2 checklist item, call `workflow_progress` with that `item_id` and `status: \"checking\"`.",
    "- If Phase 1 finds actionable adoption work, complete safe local updates directly when your available tools allow it.",
    "- For risky or external side effects, propose an approval flow instead of acting silently.",
    "- If Phase 1 finds no adoption work, explicitly say that Phase 2 is skipped and why.",
    "- After each Phase 2 item, call `workflow_progress` with `status: \"done\"`, `status: \"skipped\"`, or `status: \"needs_attention\"`.",
    "- Before your final response, call `workflow_progress` with `workflow_id: \"version_adoption\"`, `phase: \"complete\"`, and a concise `summary`.",
    "",
    "Constraints:",
    "- Do not create external issues, PRs, scheduled tasks, watcher updates, or credential changes unless the user explicitly approves.",
    "- Keep the response concise: what changed, what you checked, what was adopted, what was skipped, and any approval needed.",
    "",
    `Summary: ${state.summary}`,
    "Phase 1 checklist:",
    ...PHASE_1_CHECKLIST.map((item) => `- ${item.id}: ${item.label} — ${item.reason}`),
    "Phase 2 adoption checklist:",
    ...buildChecklist(state.previous_version, state.current_version).map((item) => `- ${item.id}: ${item.label}: ${item.reason}${item.affected_files.length > 0 ? ` Affected files: ${item.affected_files.join(", ")}.` : ""}`),
    state.stale_prompt_risks.length > 0 ? `Stale-prompt risks: ${state.stale_prompt_risks.join(", ")}.` : "Stale-prompt risks: none detected in the checklist.",
  ].join("\n");
}

function createState(currentVersion: string, previousVersion: string | null): StoredVersionAdoptionState {
  const defaultAgent = getDefaultAgentConfig();
  const isFirst = previousVersion === null;
  const adoptionChecklist = buildChecklist(previousVersion, currentVersion);
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
    checklist: phase1Checklist(),
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
): VersionAdoptionState {
  const existing = parseStored();
  const state = existing && existing.current_version === currentVersion
    ? existing
    : createState(currentVersion, existing?.last_adopted_version ?? existing?.current_version ?? null);
  const t = now();
  const nextChecklist = state.checklist.map((entry) => ({ ...entry }));

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
    if (nextChecklist.length > 0) nextChecklist[0].status = "checking";
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
    const completed = completeWorkflow({ ...state, checklist: nextChecklist }, "complete");
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
