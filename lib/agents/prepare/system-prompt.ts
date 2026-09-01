// System-prompt assembly. Pure function: given the resolved context
// (agent config, history budget, recall hits, etc.), returns the joined
// system-prompt string passed to the provider. Each context block is a
// file-private helper; the top-level `buildSystemPrompt` joins them in
// the order the harness has documented since ADR-0033.
//
// See ADR-0039 for the decomposition rationale.

import os from "node:os";
import { CACHE_SHARED_SPLIT_SENTINEL, CACHE_SPLIT_SENTINEL } from "@/lib/providers/anthropic";
import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import { parseCitationStrictness } from "@/lib/stores/agent-configs";
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
import { listSkills } from "@/lib/skills";
import { getToolStatsMap, listToolFailureSamples, type ToolUsefulnessStats } from "@/lib/stores/tool-stats";
import type { StreamOptions } from "@/lib/agents/base";
import type { SourceManifestEntry } from "@/lib/agents/citation-checker";
import type { DeliveryChannel } from "@/lib/agents/prepare/request";
import type { ToolCatalogEntry } from "@/lib/tools";

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
   *  by run-thread from the thread's visited-source set + prior-dialog
   *  turns when the agent's `citation_strictness` is not `'off'`. Empty
   *  array or undefined disables citation. */
  sourceManifest?: ReadonlyArray<SourceManifestEntry>;
  /** Provenance of the current turn when delivered by a non-user runner
   *  (bridge, trigger, watcher). When set, a "Delivery channel" block is
   *  added near the top of the system prompt so the agent knows it's
   *  answering on e.g. WhatsApp via a configured bridge — stops the
   *  "I don't have access to WhatsApp" hallucination. */
  deliveryChannel?: DeliveryChannel | null;
  /** Tool names available to this run. Used to derive compact historical
   *  reliability hints from aggregate tool stats only. */
  allowedTools?: readonly string[];
  /** Complete tool permission metadata for this agent. Metadata only;
   *  executable tool handles are still limited by `allowedTools`. */
  toolPermissionMap?: ReadonlyArray<ToolCatalogEntry>;
}

// Re-exported so callers that only need the sentinel don't have to import the
// full providers package. The canonical definition lives in anthropic.ts.
export { CACHE_SHARED_SPLIT_SENTINEL, CACHE_SPLIT_SENTINEL } from "@/lib/providers/anthropic";

export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const { agentCfg, trimmedMessage, budget, recallCtx, warmSummaryCtx, factsCtx, experienceMode, delegateRosterLines, sourceManifest, deliveryChannel, allowedTools, toolPermissionMap } = ctx;

  const adaptivePersonaCtx = buildAdaptivePersonaContext(agentCfg, trimmedMessage);
  const harnessParts = resolveHarness(agentCfg);

  // Tier ordering follows the agent's configured priority (hot is the
  // in-prompt history itself, so it doesn't have a context block here).
  const tierCtxByName = { hot: "", warm: warmSummaryCtx, facts: factsCtx } as const;
  const tierOrderCtx = budget.tierPriority.map((t) => tierCtxByName[t]).filter(Boolean);

  // Shared prefix: cross-agent static instructions and a compact full tool index.
  // This text is intentionally before agent identity/instructions and is split
  // into its own provider cache block so multiple agents can reuse it.
  const sharedStableParts: (string | null | undefined)[] = [
    buildSharedToolCatalogContext(toolPermissionMap ?? []),
  ];

  // Agent-stable prefix: persona, integration/doc/skill facts, harness sections,
  // and other content that rarely changes within this agent/session. Keep
  // request-scored state (for example provider-cap tool selection) out of this
  // block so Anthropic's ephemeral prompt cache survives across user turns.
  const agentStableParts: (string | null | undefined)[] = [
    agentCfg.identity,
    agentCfg.instructions,
    buildDeliveryChannelContext(deliveryChannel),
    buildUserContext(),
    buildIntegrationsContext(),
    buildDocumentsContext(),
    buildSkillsContext(),
    harnessParts.capabilities,
    harnessParts.plan_first,
    harnessParts.presentation,
    harnessParts.citation,
    buildEnvContext(),
    harnessParts.self_config,
    buildMemoryContext(budget),
    buildDelegatesContext(delegateRosterLines),
    buildExperienceContext(experienceMode),
  ];

  // Dynamic suffix: content that changes on every turn (timestamp, per-turn
  // recall, output budget derived from model params, provider-cap-selected
  // tool state). Placed AFTER the sentinel so it never touches the stable cache
  // breakpoint.
  const dynamicParts: (string | null | undefined)[] = [
    adaptivePersonaCtx,
    buildToolPermissionContext(toolPermissionMap ?? []),
    buildToolReliabilityContext(allowedTools ?? []),
    buildSourceLinkContext(agentCfg, sourceManifest ?? []),
    buildTimeContext(),
    buildOutputBudgetContext(budget),
    ...tierOrderCtx,
    recallCtx,
  ];

  const sharedStable = sharedStableParts.filter(Boolean).join("\n\n");
  const agentStable = agentStableParts.filter(Boolean).join("\n\n");
  const dynamic = dynamicParts.filter(Boolean).join("\n\n");
  return `${sharedStable}\n\n${CACHE_SHARED_SPLIT_SENTINEL}\n\n${agentStable}\n\n${CACHE_SPLIT_SENTINEL}\n\n${dynamic}`;
}

const TOOL_RECOVERY_HINTS: Record<string, string> = {
  documents_search: "check document sources/indexing before retrying; if source_id is supplied, verify it exists",
  calendar_list_events: "use full RFC3339 datetime strings for time_min/time_max and verify the calendar id",
  gmail_modify_message: "verify message and label ids first; if auth fails, guide the user to Gmail integration setup",
  gmail_create_draft: "keep draft bodies bounded and validate recipient/thread ids before creating",
  gmail_send_email: "only send after an explicit user request; otherwise create a draft for review",
  outlook_create_draft: "keep draft bodies bounded and verify Microsoft auth before creating",
  outlook_send_email: "only send after an explicit user request; if 403, reconnect Outlook with Mail.Send",
  browser_click: "refresh handles with browser_snapshot before retrying stale or ambiguous targets",
  propose_config_change: "validate the proposal kind and required payload fields before calling",
  ms_graph_get: "prefer narrow paths with $select and bounded pagination; verify Microsoft auth/scopes first",
  ms_search: "keep queries simple and verify Microsoft auth/scopes first",
};

export function buildToolReliabilityContext(allowedTools: readonly string[]): string {
  if (allowedTools.length === 0) return "";
  const statsMap = getToolStatsMap(allowedTools);
  const allowed = new Set(allowedTools);
  const rows = [...statsMap.entries()]
    .filter(([, stats]) => stats.call_count >= 3 && !stats.never_used);
  const failureHints = buildFailurePatternHints(allowed);
  if (rows.length === 0 && failureHints.length === 0) return "";

  const problematic = rows
    .filter(([, stats]) => isProblematicTool(stats))
    .sort((a, b) => problemSeverity(b[1]) - problemSeverity(a[1]))
    .slice(0, 5);
  const reliable = rows
    .filter(([, stats]) => stats.score >= 0.85 && stats.success_rate >= 0.85)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 3);

  if (problematic.length === 0 && reliable.length === 0 && failureHints.length === 0) return "";

  const lines = [
    "--- Tool reliability hints ---",
    "Use these aggregate historical signals as recovery guidance, not hard bans.",
  ];
  if (reliable.length > 0) {
    lines.push("Prefer when applicable:");
    for (const [name] of reliable) lines.push(`- ${name}: historically reliable.`);
  }
  if (problematic.length > 0) {
    lines.push("Verify before using or recover carefully:");
    for (const [name] of problematic) {
      lines.push(`- ${name}: ${TOOL_RECOVERY_HINTS[name] ?? "high recent failure/usefulness risk; validate inputs and avoid blind retries"}.`);
    }
  }
  if (failureHints.length > 0) {
    lines.push("Recurring failure patterns:");
    lines.push(...failureHints);
  }
  return lines.join("\n");
}

export function buildToolPermissionContext(permissionMap: ReadonlyArray<ToolCatalogEntry>): string {
  if (permissionMap.length === 0) return "";
  const ordered = [...permissionMap].sort(compareToolPermissionEntries);
  const enabled = ordered.filter((tool) => tool.permission === "enabled");
  const disabled = ordered.filter((tool) => tool.permission === "disabled");
  const unavailable = ordered.filter((tool) => tool.permission === "unavailable");
  const capped = ordered.filter((tool) => tool.permission_reason === "provider_tool_limit");
  const lines = [
    "--- Enabled tools ---",
    `You can execute the ${enabled.length} tool(s) listed below. ${disabled.length} known tool(s) are not enabled for this agent; ${unavailable.length} known tool(s) are globally unavailable.`,
    "Use an enabled tool directly when the right tool is listed below. If the needed capability is missing or ambiguous, search the full tool catalog with list_tools using service/object/action keywords before concluding it is unavailable. Use list_tools include_schema=true when you need argument specs for invoke_tool.",
    "The shared cached full tool index is compact discovery metadata only; a cached name is executable only when it also appears in the enabled list or list_tools shows it is enabled but provider-cap omitted.",
    "When a provider tool cap is active, the executable tool subset is selected for this turn from the user's request and the agent's pinned tools.",
    "The full tool inventory is embedded above as a compact cached index; call list_tools with scope=\"enabled\" to search executable tools, scope=\"all\" to include disabled/unavailable tools with flags, or include_schema=true when exact argument schemas are needed.",
  ];
  if (capped.length > 0) {
    lines.push(
      `Provider tool cap is active: ${capped.length} otherwise-enabled tool(s) were omitted from this turn with reason=provider_tool_limit.`,
      "Use list_tools with query plus scope=\"all\" and include_schema=true to search omitted candidates. If a needed tool is omitted only by provider_tool_limit and invoke_tool is enabled, call invoke_tool with the exact target name and args. If invoke_tool is unavailable or the tool is disabled/unavailable for another reason, propose moving less relevant tools out of this agent's list or ask the user to retry with a narrower request/tool selection.",
    );
  }
  for (const tool of enabled) lines.push(formatToolPermissionLine(tool));
  return lines.join("\n");
}

export function buildSharedToolCatalogContext(permissionMap: ReadonlyArray<ToolCatalogEntry>): string {
  const toolIndex = buildCompactToolCatalogLines(permissionMap);
  const lines = [
    "--- Shared tool discovery cache ---",
    "This cross-agent block is intentionally static: it describes stable full-catalog discovery workflow and a compact full tool index. The current per-agent/per-turn executable subset and omission counts are listed later under Enabled tools.",
    "Full catalog workflow: list_tools is the authoritative spec lookup for every registered built-in, external, and MCP tool, including tools not directly loaded in this turn. Search it with service/object/action keywords; set scope=\"all\" to see disabled, unavailable, and provider-cap-omitted tools; set include_schema=true to get the target JSON argument schema.",
    "Invoke proxy workflow: call enabled tools directly when they are loaded. Use invoke_tool only after list_tools identifies an exact target that is permitted for this agent but not directly loaded, especially permission_reason=\"provider_tool_limit\". Do not use invoke_tool for invoke_tool itself or for tools marked agent_not_allowed, category_disabled, unavailable, missing credentials, or disabled drop-ins; propose or ask for configuration instead.",
  ];
  if (toolIndex.length > 0) {
    lines.push("Cached full tool index:");
    lines.push(...toolIndex);
  }
  return lines.join("\n");
}

function compareToolPermissionEntries(a: ToolCatalogEntry, b: ToolCatalogEntry): number {
  const groupDiff = groupLabel(a).localeCompare(groupLabel(b));
  if (groupDiff !== 0) return groupDiff;
  const categoryDiff = a.category.localeCompare(b.category);
  if (categoryDiff !== 0) return categoryDiff;
  return a.name.localeCompare(b.name);
}

function groupLabel(tool: ToolCatalogEntry): string {
  return tool.group ?? "Other";
}

function formatToolPermissionLine(tool: ToolCatalogEntry): string {
  const permission = tool.permission ?? "disabled";
  const reason = tool.permission_reason ?? tool.status_reason;
  const statusSuffix = reason ? ` reason=${reason}` : "";
  return `- ${groupLabel(tool)} > ${tool.category} > ${tool.name}: ${tool.capability}/${tool.source}/${permission}${statusSuffix}`;
}

function buildCompactToolCatalogLines(catalog: ReadonlyArray<ToolCatalogEntry>): string[] {
  const byCategory = new Map<string, string[]>();
  for (const tool of [...catalog].sort(compareToolPermissionEntries)) {
    const categoryPath = `${groupLabel(tool)} > ${tool.category}`;
    const names = byCategory.get(categoryPath) ?? [];
    names.push(formatCompactToolSpec(tool));
    byCategory.set(categoryPath, names);
  }
  return Array.from(byCategory.entries(), ([categoryPath, names]) => `- ${categoryPath}: ${names.join(", ")}`);
}

function formatCompactToolSpec(tool: ToolCatalogEntry): string {
  const source = tool.source === "mcp" && tool.mcp_server
    ? `mcp:${tool.mcp_server}`
    : tool.source;
  return `${tool.name}(${tool.capability}/${source})`;
}

function buildFailurePatternHints(allowed: ReadonlySet<string>): string[] {
  return listToolFailureSamples()
    .filter((sample) => allowed.has(sample.tool_name) && sample.count >= 2)
    .filter((sample) => sample.normalized_reason !== "other")
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((sample) => {
      const hint = failureReasonHint(sample.normalized_reason);
      return `- ${sample.tool_name}: repeated ${sample.normalized_reason} failures; ${hint}.`;
    });
}

function failureReasonHint(reason: string): string {
  switch (reason) {
    case "auth": return "verify the integration/credential setup before retrying";
    case "permission": return "check scopes/permissions and avoid retry loops until access changes";
    case "not_found": return "refresh ids/list sources first, or ask the user for the correct target";
    case "validation": return "repair argument format locally before calling again";
    case "timeout": return "split large changes into smaller batches, checkpoint progress, and avoid retrying the same huge call";
    case "rate_limited": return "wait, reduce request volume, or switch credentials/providers before retrying";
    case "size_or_context": return "reduce payload size, narrow scope, or summarize before retrying";
    default: return "validate inputs and avoid blind retries";
  }
}

function isProblematicTool(stats: ToolUsefulnessStats): boolean {
  const errorRate = stats.call_count > 0 ? stats.error_count / stats.call_count : 0;
  return errorRate >= 0.25 || stats.success_rate < 0.75 || stats.score < 0.6;
}

function problemSeverity(stats: ToolUsefulnessStats): number {
  const errorRate = stats.call_count > 0 ? stats.error_count / stats.call_count : 0;
  return (errorRate * 0.5) + ((1 - stats.success_rate) * 0.3) + ((1 - stats.score) * 0.2);
}

export function resolveExperienceMode(options?: StreamOptions): "essential" | "full" {
  // Accept both the new ("essential"/"full") and legacy ("normal"/"advanced")
  // labels so an older client speaking to a newer server still works.
  const raw = options?.ui_experience_mode;
  return raw === "essential" || raw === "normal" ? "essential" : "full";
}

// ── Context block builders (file-private) ────────────────────────────────

// Map a bridge / trigger / watcher kind tag to a user-facing platform
// name. New bridge kinds added later just need an entry here.
const DELIVERY_KIND_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  slack: "Slack",
  telegram: "Telegram",
  discord: "Discord",
  sms: "SMS",
  email: "email",
  trigger: "scheduled trigger",
  watcher: "page watcher",
  scheduler: "scheduled task",
};

function buildDeliveryChannelContext(channel: DeliveryChannel | null | undefined): string {
  if (!channel || !channel.kind) return "";
  const platform = DELIVERY_KIND_LABELS[channel.kind] ?? channel.kind;
  const named = channel.name && channel.name !== channel.kind
    ? ` (configured as "${channel.name}")`
    : "";
  return [
    "--- Delivery channel ---",
    `This message reached you over ${platform}${named}, not the regular chat UI.`,
    `You DO have access to ${platform} for this conversation: any reply you produce is sent back through that channel automatically. Do not tell the user the platform is unavailable; just answer the message.`,
  ].join("\n");
}

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

// Citation enforcement directive. Empty unless the agent's
// `citation_strictness` is not `'off'`. Shows the numbered source
// manifest (tool-visited sources + memory items + prior assistant turns)
// the agent may cite via inline `[N]` markers — the chat UI renders each
// `[N]` as a clickable link or anchor. Invented numbers stay as plain
// text and are flagged by the post-turn checker.
//
// Strictness levels:
//   informational — agent NOT asked to cite (checker still surfaces
//                   references in the UI)
//   standard      — agent nudged to cite KEY (load-bearing) claims
//   strict        — agent asked to cite EVERY factual claim
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
  const strictness = parseCitationStrictness(agent.citation_strictness) ?? "off";
  if (strictness === "off" || strictness === "informational") return "";

  const intro =
    strictness === "strict"
      ? "Your reply will be audited by a second-pass model that ranks every factual claim by impact. Cite EVERY factual claim — quoted numbers, file contents, API behavior, named facts, paraphrases of earlier turns. The audit downgrades unsupported claims as low-confidence; citing up front saves you from re-grounding rounds for things you already know."
      : "Your reply will be audited by a second-pass model that ranks every factual claim by impact. Cite KEY load-bearing claims (quoted numbers, file contents, API behavior, named facts). Don't mark incidentals, summaries, plans, or your own derivations — over-citing is as bad as not citing. The audit re-grounds unsupported KEY claims; citing up front saves the extra round.";

  // The pre-turn manifest is always empty under the current design — we
  // surface citable references in the post-turn manifest after tool
  // events have actually been recorded. So the only valid citation form
  // during drafting is the inline markdown link.
  void manifest;
  return [
    "--- Citation format ---",
    intro,
    "PRIMARY (inline links): cite by writing a standard markdown link inline: `[short label](https://example.com/path)` or `[file name](/abs/path.ts)` or `[earlier reply](#msg-<id>)`. Wrap the cited PHRASE itself as the link text when natural — `Jade has [ice skating at 16:00](?thread=…&agent=…)` reads better than a trailing `[1]`.",
    "When a tool result contains a `cite_as` field (delegate_to_agent does, and so do some integrations), paste that exact value somewhere in your reply — it's a pre-built markdown link to the source. Anything you summarize from a delegate or from a web/file tool result MUST carry at least one inline link back to where it came from; a summary with zero links reads as if you made the facts up.",
    "For web_search / fetch_webpage results, the URL is right there in the tool output — use it: `[headline or short label](https://...)`. For file_read results, link the absolute path: `[filename.ext](/abs/path/filename.ext)`.",
    "FALLBACK (declared refs block): if a source is awkward to cite inline (e.g. you summarized 4 articles in one paragraph), you MAY end your reply with a fenced block exactly like this:",
    "```jarela-references",
    "[",
    "  { \"label\": \"CNN — Mars mission\", \"href\": \"https://cnn.com/...\" },",
    "  { \"label\": \"Postman's reply\", \"href\": \"?thread=...&agent=...\" }",
    "]",
    "```",
    "Rules for the declared-refs block: it MUST be the very last thing in your reply, MUST be valid JSON (an array of `{label, href}` objects, both strings), and MUST be inside a fenced code block tagged exactly `jarela-references`. The block is stripped from your reply before it's shown to the user — the entries appear as numbered chips in a References footer the UI builds automatically. Use this sparingly — inline links are always preferred because they show the user which words came from where.",
    "DO NOT write `[CNN, June 4]`, `[Reuters]`, `[AP News]`, or any other bare-text bracket without a URL — those are NOT citations, they render as plain text and the audit counts them as uncited.",
    "If a claim is central to your answer and you have no link to attach, ground it first via a tool (web_search, fetch_webpage, file_read, …) before stating it.",
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

function buildOutputBudgetContext(budget: ContextBudget): string {
  const tokens = budget.outputReserveTokens;
  const words = Math.round(tokens * 0.75);
  return [
    "--- Output budget ---",
    `Your reply is capped at ~${tokens} output tokens per turn (≈${words} words). The provider truncates mid-sentence if you exceed it — you will not get a chance to finish.`,
    "- Lead with the answer. Skip preambles, restating the question, and recapping context the user already sees.",
    "- If the user asks for a long artifact (essay, plan, large code dump, exhaustive list), estimate the size first. If it won't fit, ask whether to split across turns, summarise, or stream only the requested section.",
    "- Prefer dense prose and tight bullets over verbose explanation. Don't repeat yourself across paragraphs.",
  ].join("\n");
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

function buildSkillsContext(): string {
  const skills = listSkills();
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `  - ${s.id} (${s.source})${s.description ? `: ${s.description}` : ""}`);
  return [
    "--- Available skills ---",
    "Use read_skill(id) to load a skill's full instructions before applying it. Only load skills relevant to the current task.",
    ...lines,
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
