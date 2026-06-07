// System-prompt assembly. Pure function: given the resolved context
// (agent config, history budget, recall hits, etc.), returns the joined
// system-prompt string passed to the provider. Each context block is a
// file-private helper; the top-level `buildSystemPrompt` joins them in
// the order the harness has documented since ADR-0033.
//
// See ADR-0039 for the decomposition rationale.

import os from "node:os";
import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import { getUserProfile } from "@/lib/stores/user-profile";
import { listIntegrations } from "@/lib/stores/integrations";
import { listEnabledDocumentSources, getDocumentSourceStats } from "@/lib/stores/document-sources";
import { buildAdaptivePersonaContext } from "@/lib/agents/adaptive-persona";
import { resolveHarness } from "@/lib/agents/harness/resolve";
import {
  type ContextBudget,
  formatContextBudgetSummary,
} from "@/lib/agents/context-budget";
import { getAppName } from "@/lib/env/app-config";
import type { StreamOptions } from "@/lib/agents/base";
import type { SourceManifestEntry } from "@/lib/agents/citation-checker";

const APP_NAME = getAppName();

export interface SystemPromptContext {
  agentCfg: AgentConfigRow;
  trimmedMessage: string;
  budget: ContextBudget;
  recallCtx: string;
  warmSummaryCtx: string;
  factsCtx: string;
  experienceMode: "essential" | "full";
  delegateRosterLines: string[];
  /** Numbered source manifest the agent may cite via `[N]` markers. Built
   *  by run-thread from the thread's visited-source set when the agent has
   *  `require_source_links` on; empty/undefined disables citation. */
  sourceManifest?: ReadonlyArray<SourceManifestEntry>;
}

export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const { agentCfg, trimmedMessage, budget, recallCtx, warmSummaryCtx, factsCtx, experienceMode, delegateRosterLines, sourceManifest } = ctx;

  const adaptivePersonaCtx = buildAdaptivePersonaContext(agentCfg, trimmedMessage);
  const harnessParts = resolveHarness(agentCfg);

  // Tier ordering follows the agent's configured priority (hot is the
  // in-prompt history itself, so it doesn't have a context block here).
  const tierCtxByName = { hot: "", warm: warmSummaryCtx, facts: factsCtx } as const;
  const tierOrderCtx = budget.tierPriority.map((t) => tierCtxByName[t]).filter(Boolean);

  const parts: (string | null | undefined)[] = [
    agentCfg.identity,
    agentCfg.instructions,
    adaptivePersonaCtx,
    buildUserContext(),
    buildIntegrationsContext(),
    buildDocumentsContext(),
    harnessParts.capabilities,
    harnessParts.plan_first,
    harnessParts.presentation,
    harnessParts.citation,
    buildSourceLinkContext(agentCfg, sourceManifest ?? []),
    buildTimeContext(),
    buildEnvContext(),
    harnessParts.self_config,
    buildExperienceContext(experienceMode),
    buildMemoryContext(budget),
    ...tierOrderCtx,
    recallCtx,
    buildDelegatesContext(delegateRosterLines),
  ];

  return parts.filter(Boolean).join("\n\n");
}

export function resolveExperienceMode(options?: StreamOptions): "essential" | "full" {
  // Accept both the new ("essential"/"full") and legacy ("normal"/"advanced")
  // labels so an older client speaking to a newer server still works.
  const raw = options?.ui_experience_mode;
  return raw === "essential" || raw === "normal" ? "essential" : "full";
}

// ── Context block builders (file-private) ────────────────────────────────

function buildUserContext(): string {
  const userProfile = getUserProfile();
  const parts: string[] = [];
  if (userProfile?.name) parts.push(`Name: ${userProfile.name}`);
  if (userProfile?.about) parts.push(`About: ${userProfile.about}`);
  if (
    userProfile?.location_consent === 1 &&
    typeof userProfile.location_lat === "number" &&
    typeof userProfile.location_lng === "number"
  ) {
    const ageSec = userProfile.location_updated_at
      ? Math.round((Date.now() - Date.parse(userProfile.location_updated_at)) / 1000)
      : null;
    const ageStr = ageSec === null ? "unknown age"
      : ageSec < 120 ? `${ageSec}s ago`
      : ageSec < 7200 ? `${Math.round(ageSec / 60)}m ago`
      : `${Math.round(ageSec / 3600)}h ago`;
    const acc = userProfile.location_accuracy_m != null
      ? ` (±${Math.round(userProfile.location_accuracy_m)}m)` : "";
    const label = userProfile.location_label ? ` — ${userProfile.location_label}` : "";
    parts.push(
      `Location: ${userProfile.location_lat.toFixed(5)}, ${userProfile.location_lng.toFixed(5)}${acc}${label} [updated ${ageStr}]`,
      "  (User has opted in to share location. Use it for any location-dependent answer — weather, nearby places, directions, local time. Call get_user_location for the freshest values.)",
    );
  }
  return parts.length > 0 ? `--- User context ---\n${parts.join("\n")}` : "";
}

function buildTimeContext(): string {
  return `Current time: ${new Date().toISOString()} (UTC). Use this when computing scheduled task timestamps.`;
}

// Citation enforcement directive. Empty unless the agent has
// `require_source_links` on. Shows the numbered source manifest the agent
// may cite via inline `[N]` markers — the chat UI renders each `[N]` as
// a clickable link to the corresponding source. Built from the thread's
// visited-source set (tool calls like file_read, web_search, fetch_webpage)
// so the agent can only cite what it has actually opened in this thread;
// invented numbers stay as plain text (not rendered as links) and are
// flagged by the post-turn checker.
//
// Numbered markers were chosen over free-form `[label](href)` because
// long-form LLM output reliably regresses to its training distribution
// when asked to type exact paths mid-sentence — Perplexity, Wikipedia,
// and Anthropic's first-party Citations all sidestep that by letting the
// model emit a short stable token (`[3]`) and resolving the link
// out-of-band. Same idea here.
function buildSourceLinkContext(
  agent: AgentConfigRow,
  manifest: ReadonlyArray<SourceManifestEntry>,
): string {
  if (!agent.require_source_links) return "";
  if (manifest.length === 0) {
    return [
      "--- Sources you can cite ---",
      "You haven't opened any sources in this conversation yet, so factual claims can't be cited from this thread. If a claim is central to your answer, open the source first via a tool (file_read, file_grep, file_glob, web_search, fetch_webpage, …) before stating it. If you're going from memory, say so plainly instead of stating it as if you'd checked.",
    ].join("\n");
  }
  const lines = manifest.map((e) => {
    const trailer = e.label === e.href ? "" : ` — ${e.href}`;
    return `[${e.n}] ${e.label}${trailer}`;
  });
  return [
    "--- Sources you can cite ---",
    "Attach a citation to KEY factual claims by writing a numbered marker like [1] or [3] in-prose, right after the claim. KEY = the load-bearing facts a careful reader would want a source for (a quoted number, a specific file's contents, an API behavior, a named fact). Don't mark incidental details, summaries, plans, or your own derivations — over-citing is as bad as not citing. Use ONLY the numbers in the list below; never invent a number. If a KEY claim has no matching source, either state it plainly without a marker or, if it's central to your answer, open the source first via a tool and cite it next turn. The chat UI renders each `[N]` as a clickable link, so you don't need to type the path or URL.",
    "",
    ...lines,
  ].join("\n");
}

function buildExperienceContext(mode: "essential" | "full"): string {
  return [
    "--- UX mode ---",
    `User interface mode: ${mode}.`,
    mode === "essential"
      ? "Prefer concise, plain-language explanations and avoid exposing low-level configuration details unless asked."
      : "User opted into the full / advanced UI; detailed technical explanations are welcome.",
  ].join("\n");
}

function buildEnvContext(): string {
  return [
    "--- Host environment ---",
    `Platform: ${process.platform} (${process.arch})`,
    `CWD: ${process.cwd()}`,
    `Home: ${os.homedir()}`,
    process.platform === "win32"
      ? "iCloud Drive on Windows (if installed): %USERPROFILE%\\iCloudDrive (a.k.a. ~\\iCloudDrive)"
      : process.platform === "darwin"
        ? "iCloud Drive on macOS: ~/Library/Mobile Documents/com~apple~CloudDocs"
        : "",
    `File-tool path resolution: absolute paths and \`~/...\` are honored verbatim; BARE RELATIVE paths (e.g. \`notes.txt\`) resolve against HOME, not cwd. cwd is the ${APP_NAME} install directory and should never be used as a default location for user files.`,
    "Verify file paths with file_stat or file_list before assuming they exist. Always echo the resolved absolute path back to the user when you create/move/delete a file so they know where it landed.",
  ].filter(Boolean).join("\n");
}

function buildIntegrationsContext(): string {
  // Surface configured integrations so the LLM knows native tools are wired
  // and ready. Without this, the model defaults to shell-exec'ing CLIs (`jira`,
  // `gh`, etc.) because that's what its training data covers — even though
  // the typed REST tools are right there in the function list.
  const configured = listIntegrations().filter((i) => i.configured);
  if (configured.length === 0) return "";

  const lines: string[] = ["--- Configured integrations (use the typed tools, not shell CLIs) ---"];
  for (const i of configured) {
    if (i.name === "atlassian") {
      const url = i.values.url;
      lines.push(
        `Atlassian: ${url} as ${i.values.email}.`,
        "  Use jira_search / jira_get_issue / jira_create_issue / jira_add_comment / jira_transition_issue / confluence_search / confluence_get_page.",
        "  DO NOT shell out to a `jira` or `acli` CLI — these REST tools are already authenticated and use the corporate proxy correctly.",
      );
    } else if (i.name === "jira_align") {
      lines.push(
        "Jira Align: configured.",
        "  Use jira_align_search_items / jira_align_get_item / jira_align_create_item / jira_align_update_item / jira_align_transition_item / jira_align_add_comment.",
      );
    } else if (i.name === "github") {
      lines.push(
        "GitHub: configured.",
        "  Use github_* tools for issues/PRs/code/reviews (search, create, update, comment, merge, file fetch) instead of shelling out to `gh`.",
      );
    } else if (i.name === "gmail") {
      lines.push(
        "Gmail + Calendar: configured.",
        "  Use gmail_* for inbox/search/draft/labels and calendar_* for event operations. Prefer these typed tools over raw IMAP/SMTP instructions.",
      );
    } else if (i.name === "outlook") {
      lines.push(
        "Outlook + Calendar: configured.",
        "  Use outlook_* for mail operations and outlook_calendar_* for event operations.",
      );
    } else if (i.name === "google") {
      lines.push(
        "Google AI: configured.",
        "  Use generate_image when the user asks to create images; don't claim image generation is unavailable.",
      );
    } else {
      lines.push(`${i.name}: configured.`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function buildMemoryContext(budget: ContextBudget): string {
  return [
    "--- Memory & recall ---",
    "You have long-term memory across sessions and a fresh recall pass on every turn.",
    `- Hot conversation history is budgeted by model context size: ${formatContextBudgetSummary(budget)}.`,
    '- A semantic search over all stored memory entries + past chat messages was run against the user\'s turn; matching items appear under "Relevant context" below.',
    "- Use memory_write proactively when the user shares a fact, preference, or decision worth remembering. Use memory_read / memory_list to recall stored facts on demand.",
    "- If you want detail from outside the recent window, the user can scroll up — but for facts you've stored explicitly, prefer recall over guessing.",
  ].join("\n");
}

function buildDelegatesContext(lines: string[]): string {
  if (lines.length === 0) return "";
  return [
    "--- Available delegates ---",
    "You can hand subtasks to these other agents via the `delegate_to_agent` tool. Only delegate when the target agent has specialized knowledge or tools you lack — don't delegate trivial subtasks.",
    "BEFORE you call delegate_to_agent, briefly tell the user in one sentence which agent you're handing to and why. The user will see the tool card with the delegate's name, task, and final result.",
    ...lines,
  ].join("\n");
}

// Surface indexed Documents so the model knows the RAG corpus exists.
// Without this nudge agents almost never call `documents_search` — they have
// no signal that any local content is searchable. Gated on actually-indexed
// chunks (not just configured sources) so an empty/erroring source doesn't
// produce false advertising.
function buildDocumentsContext(): string {
  const sources = listEnabledDocumentSources();
  if (sources.length === 0) return "";

  let totalChunks = 0;
  const lines: string[] = [];
  for (const s of sources) {
    const stats = getDocumentSourceStats(s.id);
    if (stats.chunk_count === 0) continue;
    totalChunks += stats.chunk_count;
    const label = s.label ?? s.path;
    lines.push(`- ${label} (${s.kind}, ${stats.chunk_count} chunks)`);
  }
  if (totalChunks === 0) return "";

  return [
    "--- Indexed documents ---",
    `The user has ${totalChunks} indexed chunks across ${lines.length} document source(s) available to you:`,
    ...lines,
    "Call `documents_search` whenever the user asks about local files, notes, project docs, or any content that sounds like it lives in one of these sources. Prefer it over guessing from training data. Use `documents_list_sources` to enumerate, and pass `source_id` to scope a search.",
  ].join("\n");
}
