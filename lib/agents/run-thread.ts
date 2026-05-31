import { streamWithConfig } from "@/lib/agents/llm";
import type { StreamChunk, StreamOptions } from "@/lib/agents/base";
import type { ContentPart } from "@/lib/tools/types";
import { addMessage, getRecentMessagesWindow, getThread, touchThread, type PersistedToolEvent } from "@/lib/stores/threads";
import { recordToolUsage } from "@/lib/stores/tool-stats";
import { getAgentConfig, parseDelegateTargets } from "@/lib/stores/agent-configs";
import { getUserProfile } from "@/lib/stores/user-profile";
import { startScheduler } from "@/lib/scheduler";
import { recall, type RecalledMemory } from "@/lib/embeddings";
import { listIntegrations } from "@/lib/stores/integrations";
import { buildAdaptivePersonaContext } from "@/lib/agents/adaptive-persona";
import { resolveHarness } from "@/lib/agents/harness/resolve";
import { validateAssistantOutput } from "@/lib/agents/output-validator";
import { getAppName } from "@/lib/env/app-config";
import os from "node:os";
import {
  computeContextBudget,
  formatContextBudgetSummary,
  takeRecentMessagesWithinBudget,
  truncateLargestMessagesWithinBudget,
} from "@/lib/agents/context-budget";
import { listMemory } from "@/lib/stores/memory";
import { summarizeTranscript, transcriptText } from "@/lib/agents/conversation-summary";
import { getDefaultModelConfig, getModelConfig } from "@/lib/stores/model-config";
import { getProvider } from "@/lib/providers";
import type { ProviderParams } from "@/lib/providers/types";

// Resolve the app name once at module load. Forks set NEXT_PUBLIC_APP_NAME to
// rebrand the user-visible name the LLM echoes in chat replies; default
// "Jarela" for upstream. Per-turn pieces of the system prompt (user profile,
// integrations, time, env) still interpolate this constant directly.
const APP_NAME = getAppName();

export class RunThreadError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Hard cap on how long we wait for the embedding-based recall pass before
// starting the LLM stream without it. Recall is best-effort context — making
// users wait on a cold OpenAI embeddings round-trip every turn is a worse UX
// than occasionally missing a memory hit.
const RECALL_BUDGET_MS = 400;

function raceWithBudget<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, ms);
    promise.then(
      (v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } },
      () => { if (!settled) { settled = true; clearTimeout(t); resolve(fallback); } },
    );
  });
}

// The harness sections (capabilities, plan-first, presentation, citation,
// self-config) used to live here as hard-coded constants. They moved to
// `lib/agents/harness/presets.ts` as the body of `builtin:default`, and
// `resolveHarness(agentCfg)` returns them per-turn (allowing per-agent
// override + global default selection). See ADR-0033.

export interface PreparedThreadRun {
  stream: AsyncIterable<StreamChunk>;
  thread_id: string;
}

// Max times we'll auto-retry a single user turn when the model emits a
// "one moment" stall without firing any tool. One retry is plenty — if the
// model is *still* stalling after a forceful nudge, looping further just
// burns tokens and the warning footer on the persisted message gives the
// user a clear manual recovery path ("continue").
const MAX_STALL_AUTO_RETRIES = 1;

// Hard cap on how deep an A → B → C delegation chain can go via the
// `delegate_to_agent` built-in tool. Public callers start at depth 0; the
// delegate tool increments before recursively invoking prepareThreadRun. At
// depth >= MAX_DELEGATION_DEPTH the tool refuses with `depth_exceeded` so a
// mis-configured agent network can't runaway.
export const MAX_DELEGATION_DEPTH = 2;

function parseContent(raw: string): string | ContentPart[] {
  if (!raw.startsWith("[")) return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      typeof parsed[0] === "object" &&
      parsed[0] !== null &&
      "type" in (parsed[0] as object)
    ) {
      return parsed as ContentPart[];
    }
  } catch {
    // not valid JSON — treat as plain text
  }
  return raw;
}

function contentText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is ContentPart & { type: "text" } => p.type === "text")
    .map((p) => p.text)
    .join(" ");
}

export async function prepareThreadRun(
  thread_id: string,
  message: string,
  options?: StreamOptions,
  attachments?: ContentPart[],
  signal?: AbortSignal,
  // Internal: tracks how many stall-retries are still allowed in this turn.
  // Public callers leave this undefined and get the default budget. The
  // wrapper decrements it when it recursively re-invokes prepareThreadRun.
  _stallRetriesLeft: number = MAX_STALL_AUTO_RETRIES,
  // Optional classification tag persisted on the injected user message.
  // Surfaces in the chat panel's category-filter toolbar (e.g.
  // 'scheduled_task', 'bridge', 'synthetic'). undefined = ordinary chat.
  userCategory: string | null = null,
  // Internal: delegation chain context. Set by the `delegate_to_agent` tool
  // when it recursively invokes prepareThreadRun for a child agent. Depth
  // gates the recursion via MAX_DELEGATION_DEPTH; ancestors gates cycles.
  _delegationDepth: number = 0,
  _delegationAncestors: readonly string[] = [],
): Promise<PreparedThreadRun> {
  // Lazy-start the scheduler when any agent activity occurs so previously
  // saved scheduled tasks resume firing across server restarts.
  startScheduler();

  const thread = getThread(thread_id);
  if (!thread) throw new RunThreadError(404, "Thread not found", "thread_not_found");

  const trimmed = message.trim();
  if (!trimmed && !attachments?.length) {
    throw new RunThreadError(400, "message required", "message_required");
  }

  const agentCfg = getAgentConfig(thread.agent_id);
  if (!agentCfg) {
    throw new RunThreadError(404, `Agent "${thread.agent_id}" not found`, "agent_not_found");
  }

  const content: string | ContentPart[] =
    attachments?.length ? [{ type: "text", text: trimmed }, ...attachments] : trimmed;

  const stored = typeof content === "string" ? content : JSON.stringify(content);
  addMessage(thread_id, "user", stored, undefined, userCategory);
  touchThread(thread_id, trimmed.slice(0, 80) || undefined);

  // Build the LLM history window: latest N messages that are also within the
  // last X hours. Both bounds come from the agent's config (defaults 50 / 8h).
  // The full history remains queryable via getMessages for the UI.
  const limit = agentCfg.history_limit ?? 50;
  const windowHours = agentCfg.history_window_hours ?? 8;
  const sinceISO = windowHours > 0
    ? new Date(Date.now() - windowHours * 3600_000).toISOString()
    : undefined;
  const allWindowMessages = getRecentMessagesWindow(thread_id, limit, sinceISO);

  const modelCfg = agentCfg.model_config_name
    ? getModelConfig(agentCfg.model_config_name)
    : getDefaultModelConfig();
  let providerParams: ProviderParams = {};
  if (modelCfg) {
    try {
      providerParams = JSON.parse(modelCfg.params) as ProviderParams;
    } catch {
      providerParams = {};
    }
  }

  const budget = computeContextBudget({
    context_window_tokens:
      typeof providerParams.context_window_tokens === "number"
        ? providerParams.context_window_tokens
        : undefined,
    max_tokens: typeof providerParams.max_tokens === "number" ? providerParams.max_tokens : undefined,
    context_tier_proportions:
      typeof providerParams.context_tier_proportions === "object" && providerParams.context_tier_proportions
        ? (providerParams.context_tier_proportions as { hot?: number; warm?: number; facts?: number })
        : undefined,
    context_tier_priority: providerParams.context_tier_priority,
  });

  const hotMessages = takeRecentMessagesWithinBudget(allWindowMessages, budget.tierBudgets.hot);

  // Build agent run config from DB record
  const userProfile = getUserProfile();
  const userCtxParts: string[] = [];
  if (userProfile?.name) userCtxParts.push(`Name: ${userProfile.name}`);
  if (userProfile?.about) userCtxParts.push(`About: ${userProfile.about}`);
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
    userCtxParts.push(
      `Location: ${userProfile.location_lat.toFixed(5)}, ${userProfile.location_lng.toFixed(5)}${acc}${label} [updated ${ageStr}]`,
      "  (User has opted in to share location. Use it for any location-dependent answer — weather, nearby places, directions, local time. Call get_user_location for the freshest values.)",
    );
  }
  const userCtx = userCtxParts.length > 0
    ? `--- User context ---\n${userCtxParts.join("\n")}`
    : null;

  const timeCtx = `Current time: ${new Date().toISOString()} (UTC). Use this when computing scheduled task timestamps.`;
  // Accept both the new ("essential"/"full") and legacy ("normal"/"advanced")
  // labels so an older client speaking to a newer server still works.
  const rawMode = options?.ui_experience_mode;
  const experienceMode = rawMode === "essential" || rawMode === "normal" ? "essential" : "full";
  const experienceCtx = [
    "--- UX mode ---",
    `User interface mode: ${experienceMode}.`,
    experienceMode === "essential"
      ? "Prefer concise, plain-language explanations and avoid exposing low-level configuration details unless asked."
      : "User opted into the full / advanced UI; detailed technical explanations are welcome.",
  ].join("\n");

  // Host environment hint so the agent doesn't have to guess platform-specific
  // paths (e.g. iCloud Drive lives at a different default location on Windows
  // vs. macOS). Keeps the agent grounded in the actual filesystem it's
  // operating against.
  const envCtx = [
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

  // Surface configured integrations so the LLM knows native tools are wired
  // and ready. Without this, the model defaults to shell-exec'ing CLIs (`jira`,
  // `gh`, etc.) because that's what its training data covers — even though
  // the typed REST tools are right there in the function list.
  const configuredIntegrations = listIntegrations().filter((i) => i.configured);
  const integrationsCtx = configuredIntegrations.length > 0 ? [
    "--- Configured integrations (use the typed tools, not shell CLIs) ---",
    ...configuredIntegrations.flatMap((i) => {
      if (i.name === "atlassian") {
        const url = i.values.url;
        return [
          `Atlassian: ${url} as ${i.values.email}.`,
          "  Use jira_search / jira_get_issue / jira_create_issue / jira_add_comment / jira_transition_issue / confluence_search / confluence_get_page.",
          "  DO NOT shell out to a `jira` or `acli` CLI — these REST tools are already authenticated and use the corporate proxy correctly.",
        ];
      }
      if (i.name === "jira_align") {
        return [
          "Jira Align: configured.",
          "  Use jira_align_search_items / jira_align_get_item / jira_align_create_item / jira_align_update_item / jira_align_transition_item / jira_align_add_comment.",
        ];
      }
      if (i.name === "github") {
        return [
          "GitHub: configured.",
          "  Use github_* tools for issues/PRs/code/reviews (search, create, update, comment, merge, file fetch) instead of shelling out to `gh`.",
        ];
      }
      if (i.name === "gmail") {
        return [
          "Gmail + Calendar: configured.",
          "  Use gmail_* for inbox/search/draft/labels and calendar_* for event operations. Prefer these typed tools over raw IMAP/SMTP instructions.",
        ];
      }
      if (i.name === "outlook") {
        return [
          "Outlook + Calendar: configured.",
          "  Use outlook_* for mail operations and outlook_calendar_* for event operations.",
        ];
      }
      if (i.name === "google") {
        return [
          "Google AI: configured.",
          "  Use generate_image when the user asks to create images; don't claim image generation is unavailable.",
        ];
      }
      return [`${i.name}: configured.`];
    }),
    "",
  ].join("\n") : "";

  const memoryCtx = [
    "--- Memory & recall ---",
    "You have long-term memory across sessions and a fresh recall pass on every turn.",
    `- Hot conversation history is budgeted by model context size: ${formatContextBudgetSummary(budget)}.`,
    "- A semantic search over all stored memory entries + past chat messages was run against the user's turn; matching items appear under \"Relevant context\" below.",
    "- Use memory_write proactively when the user shares a fact, preference, or decision worth remembering. Use memory_read / memory_list to recall stored facts on demand.",
    "- If you want detail from outside the recent window, the user can scroll up — but for facts you've stored explicitly, prefer recall over guessing.",
  ].join("\n");

  const warmSummaryCtx = await buildWarmSummaryContext(
    allWindowMessages,
    hotMessages.length,
    modelCfg?.provider,
    modelCfg?.model_id,
    providerParams,
    budget.tierBudgets.warm,
  );

  const warmWasExpected = budget.tierBudgets.warm > 32 && (allWindowMessages.length - hotMessages.length) >= 2;
  const hotMessagesForPrompt = !warmSummaryCtx && warmWasExpected
    ? truncateLargestMessagesWithinBudget(hotMessages, budget.tierBudgets.hot)
    : hotMessages;

  const history = hotMessagesForPrompt.map((m) => ({
    role: m.role as "user" | "assistant",
    content: parseContent(m.content),
  }));

  const factsCtx = buildFactsContext(trimmed, budget.tierBudgets.facts);

  const tierCtxByName = {
    hot: "",
    warm: warmSummaryCtx,
    facts: factsCtx,
  } as const;
  const tierOrderCtx = budget.tierPriority
    .map((tier) => tierCtxByName[tier])
    .filter(Boolean);

  // Semantic recall: pull in long-term memory + past messages relevant to this turn.
  // Skip messages from the current thread that are already in the windowed history.
  // Capped at RECALL_BUDGET_MS — if the embedding round-trip is slower than
  // that the LLM stream starts without recall hits rather than letting the
  // user stare at an idle screen waiting on a network call.
  const oldestInWindow = history.length > 0 ? contentText(history[0].content) : null;
  const recallCtx = await raceWithBudget(
    buildRecallContext(thread_id, trimmed, oldestInWindow),
    RECALL_BUDGET_MS,
    "",
  );
  const adaptivePersonaCtx = buildAdaptivePersonaContext(agentCfg, trimmed);
  const harnessParts = resolveHarness(agentCfg);

  const systemParts = [
    agentCfg.identity,
    agentCfg.instructions,
    adaptivePersonaCtx,
    userCtx,
    integrationsCtx,
    harnessParts.capabilities,
    harnessParts.plan_first,
    harnessParts.presentation,
    harnessParts.citation,
    timeCtx,
    envCtx,
    harnessParts.self_config,
    experienceCtx,
    memoryCtx,
    ...tierOrderCtx,
    recallCtx,
  ].filter(Boolean);
  let allowedTools: string[] = [];
  try {
    allowedTools = JSON.parse(agentCfg.tools) as string[];
  } catch { /* keep empty */ }

  // Delegates roster: if the agent can hand off via delegate_to_agent, nudge
  // it to (a) tell the user who it's handing to and why, and (b) only use
  // delegates listed below. Without this the LLM treats the tool as opaque.
  const delegateIds = parseDelegateTargets(agentCfg.delegate_targets);
  const canDelegate =
    delegateIds.length > 0 && allowedTools.includes("delegate_to_agent");
  if (canDelegate) {
    const lines = delegateIds
      .map((id) => {
        const child = getAgentConfig(id);
        if (!child) return null;
        const firstLine = (child.identity || child.instructions || "").split("\n")[0].slice(0, 120);
        return `  - ${child.id} — ${child.name}${firstLine ? `: ${firstLine}` : ""}`;
      })
      .filter(Boolean) as string[];
    if (lines.length > 0) {
      systemParts.push(
        [
          "--- Available delegates ---",
          "You can hand subtasks to these other agents via the `delegate_to_agent` tool. Only delegate when the target agent has specialized knowledge or tools you lack — don't delegate trivial subtasks.",
          "BEFORE you call delegate_to_agent, briefly tell the user in one sentence which agent you're handing to and why. The user will see the tool card with the delegate's name, task, and final result.",
          ...lines,
        ].join("\n"),
      );
    }
  }

  const streamOpts: StreamOptions = {
    ...options,
    agent_run_config: {
      system_prompt: systemParts.join("\n\n"),
      allowed_tools: allowedTools,
      model_config_name: agentCfg.model_config_name ?? null,
      delegation: _delegationDepth > 0 || _delegationAncestors.length > 0
        ? { depth: _delegationDepth, ancestors: _delegationAncestors }
        : undefined,
    },
  };

  const rawStream = streamWithConfig(thread_id, history, streamOpts, signal);
  return {
    stream: stallRetryStream(rawStream, thread_id, options, signal, _stallRetriesLeft, allowedTools),
    thread_id,
  };
}

async function buildWarmSummaryContext(
  allWindowMessages: readonly { role: string; content: string }[],
  hotCount: number,
  providerName: string | undefined,
  modelId: string | undefined,
  providerParams: ProviderParams,
  warmBudgetTokens: number,
): Promise<string> {
  if (warmBudgetTokens <= 32) return "";
  if (!providerName || !modelId) return "";
  const warmMessages = allWindowMessages.slice(0, Math.max(0, allWindowMessages.length - hotCount));
  if (warmMessages.length < 2) return "";

  // Keep summary input bounded by the warm budget to avoid recursive prompt bloat.
  const summaryInputChars = Math.max(0, warmBudgetTokens * 4);
  const transcript = warmMessages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${transcriptText(m.content)}`)
    .join("\n\n")
    .slice(-summaryInputChars);
  if (!transcript.trim()) return "";

  try {
    const provider = getProvider(providerName);
    const summary = await summarizeTranscript(provider, modelId, providerParams, transcript);
    if (!summary) return "";
    return [
      "--- Warm context summary ---",
      "Compressed recap of earlier messages outside the hot window:",
      summary,
    ].join("\n");
  } catch {
    return "";
  }
}

function buildFactsContext(query: string, factsBudgetTokens: number): string {
  if (factsBudgetTokens <= 16) return "";
  const charBudget = factsBudgetTokens * 4;
  const rows = listMemory("facts", query.slice(0, 120), 12);
  if (rows.length === 0) return "";

  const lines = [
    "--- Facts memory ---",
    "Durable fact entries from memory_store namespace=facts:",
  ];
  let used = 0;
  for (const row of rows) {
    const line = `- ${row.key}: ${String(row.value).slice(0, 220)}`;
    if (used > 0 && used + line.length > charBudget) break;
    lines.push(line);
    used += line.length;
  }
  return lines.length > 2 ? lines.join("\n") : "";
}

// Wraps the raw agent stream with stall-retry logic. Chunks pass through
// LIVE to the consumer (so the chat UI sees deltas as they arrive); we only
// hold the terminal `done` chunk so we can decide whether to retry. If the
// completed turn produced no tool calls AND the assistant text matches a
// "one moment"-style stall pattern, we inject a forceful nudge as a
// synthetic user message and forward the retry stream's chunks too. The
// stalled prose stays visible (already streamed) and a "↻" separator marks
// the boundary; the consumer's text/tool accumulator naturally captures
// both halves into a single combined assistant message.
async function* stallRetryStream(
  inner: AsyncIterable<StreamChunk>,
  thread_id: string,
  options: StreamOptions | undefined,
  signal: AbortSignal | undefined,
  retriesLeft: number,
  allowedTools: readonly string[],
): AsyncGenerator<StreamChunk> {
  // If no retry budget, just forward everything unchanged. The downstream
  // persistAssistantMessage will still tag a stall or fabrication with a
  // warning footer.
  if (retriesLeft <= 0) {
    for await (const chunk of inner) yield chunk;
    return;
  }

  let textBuf = "";
  const toolNames: string[] = [];
  let doneChunk: StreamChunk | null = null;
  let sawError = false;

  for await (const chunk of inner) {
    if (chunk.type === "text_delta") {
      const d = (chunk.data as { delta?: unknown } | undefined)?.delta;
      if (typeof d === "string") textBuf += d;
      yield chunk;
    } else if (chunk.type === "tool_call") {
      const name = (chunk.data as { name?: unknown } | undefined)?.name;
      if (typeof name === "string" && name) toolNames.push(name);
      yield chunk;
    } else if (chunk.type === "done") {
      // Hold the terminal marker — if we retry, the retry's `done` closes
      // the turn instead.
      doneChunk = chunk;
      break;
    } else if (chunk.type === "error") {
      sawError = true;
      yield chunk;
      return;
    } else {
      yield chunk;
    }
  }

  const stalled =
    !sawError &&
    toolNames.length === 0 &&
    textBuf.trim().length > 0 &&
    looksLikeStall(textBuf.trim());

  // Fabrication check (ADR-0037): only run when the stall path didn't claim
  // this turn — stall-retry already handles zero-tool stall-prose turns.
  const fabrication = !sawError && !stalled
    ? validateAssistantOutput(textBuf, toolNames, allowedTools)
    : ({ ok: true } as const);

  if (!stalled && fabrication.ok) {
    if (doneChunk) yield doneChunk;
    return;
  }

  // Visible separator between the stalled prose and the retry continuation,
  // so the user can see something is being re-attempted.
  yield { type: "text_delta", data: { delta: "\n\n↻ " } };

  // Inject a forceful nudge as a synthetic user message so the model sees
  // its own flagged reply + an instruction to continue. Stall and fabrication
  // get distinct, reason-aware nudges.
  const nudge = stalled
    ? "\u21bb Auto-retry: your previous reply ended with a 'one moment' style promise but you didn't call any tool, which ends the turn with nothing happening. Continue the original task NOW by invoking the appropriate tool. Do not acknowledge, do not apologize \u2014 just call the tool."
    : `\u21bb Auto-retry: output validator flagged your reply. ${"reason" in fabrication ? fabrication.reason : ""} Redo this turn without the false claim \u2014 either call the actual tool, or rephrase as a proposal/question.`;

  const retry = await prepareThreadRun(
    thread_id,
    nudge,
    options,
    undefined,
    signal,
    retriesLeft - 1,
  );
  for await (const chunk of retry.stream) yield chunk;
}

export function persistAssistantMessage(
  thread_id: string,
  content: string,
  usedTools?: readonly string[],
  toolEvents?: readonly PersistedToolEvent[],
  category: string | null = null,
): void {
  const trimmed = content.trim();
  // Append a small, persistent footer listing which tools actually ran this
  // turn. Without this, tool_call events are live-only UI — after the stream
  // ends (or on page reload, or if a mobile client missed the brief render)
  // the assistant text remains saying "I scheduled X" with no proof a tool
  // ran, which reads as a hallucination even when the tool did execute.
  let final = trimmed;
  const toolList = usedTools ? Array.from(new Set(usedTools.filter(Boolean))) : [];
  // Stall detector: model ended its turn with a "one moment" / "let me check"
  // promise but invoked no tool. The system prompt forbids this, but models
  // occasionally do it anyway. Marking the message inline gives the user a
  // concrete next-step ("type continue") instead of staring at silence.
  if (toolList.length === 0 && trimmed && looksLikeStall(trimmed)) {
    final = `${trimmed}\n\n*⚠️ Agent stalled — promised a next step but did not invoke any tool. Reply "continue" to retry.*`;
  } else if (toolList.length > 0) {
    final = `${trimmed}\n\n*— used: ${toolList.join(", ")}*`;
  }
  // Fabrication footer (ADR-0037): runs after the retry budget is exhausted
  // and a flagged reply still made it through. Look up allowed tools from
  // the agent config so callers don't have to thread it through.
  if (trimmed && !final.includes("*⚠️ Agent stalled")) {
    const allowedTools = lookupAllowedToolsForThread(thread_id);
    const v = validateAssistantOutput(trimmed, toolList, allowedTools);
    if (!v.ok) {
      final = `${final}\n\n*⚠️ Output validator flagged: ${v.reason}*`;
    }
  }
  // Cap individual tool payloads so a single 64KB file_read result doesn't
  // make every reload of this thread re-download a giant blob. Keep the
  // first ~8KB — enough to be useful, small enough to be cheap.
  const sanitizedEvents = toolEvents && toolEvents.length > 0
    ? toolEvents.map(capToolEventPayload)
    : null;
  // Strip the `?autoplay=1` hint that generate_voice embeds in /api/v1/files
  // URLs before persistence. Autoplay is a transient signal for the live
  // streaming client only — reloading the thread, scrolling back, or opening
  // the conversation from another browser must not replay TTS clips the user
  // has already heard.
  const persisted = stripAutoplayHints(final);
  if (persisted || (sanitizedEvents && sanitizedEvents.length > 0)) {
    addMessage(thread_id, "assistant", persisted, sanitizedEvents, category);
    if (sanitizedEvents && sanitizedEvents.length > 0) {
      recordToolUsage(sanitizedEvents, persisted);
    }
  }
}

// Removes `autoplay=1` from /api/v1/files/*.{wav,mp3,...} URLs that appear in
// the assistant text. Handles it as the sole query param (`?autoplay=1`) or
// combined with others (`?foo=bar&autoplay=1`, `?autoplay=1&foo=bar`).
function stripAutoplayHints(text: string): string {
  if (!text || !text.includes("autoplay=1")) return text;
  return text.replace(
    /(\/api\/v1\/files\/[^\s)"']+?\.(?:wav|mp3|ogg|webm|m4a))(\?[^\s)"']*)/gi,
    (_full, base: string, query: string) => {
      const cleaned = query
        .replace(/[?&]autoplay=1\b/g, "")
        .replace(/^&/, "?");
      return cleaned === "?" || cleaned === "" ? base : `${base}${cleaned}`;
    },
  );
}

const MAX_PERSISTED_PAYLOAD_BYTES = 8_000;

function capToolEventPayload(ev: PersistedToolEvent): PersistedToolEvent {
  try {
    const serialized = JSON.stringify(ev.payload);
    if (serialized.length <= MAX_PERSISTED_PAYLOAD_BYTES) return ev;
    return {
      ...ev,
      payload: {
        __truncated: true,
        preview: serialized.slice(0, MAX_PERSISTED_PAYLOAD_BYTES),
        original_bytes: serialized.length,
      },
    };
  } catch {
    return { ...ev, payload: { __truncated: true, error: "unserializable" } };
  }
}

const STALL_PATTERNS: RegExp[] = [
  /\bone (moment|sec(?:ond)?)\b/i,
  /\bgive me (a|just a) (moment|sec(?:ond)?|minute)\b/i,
  /\bhold on\b/i,
  /\bjust a (moment|sec(?:ond)?|minute)\b/i,
  /\bbear with me\b/i,
  /\blet me (check|verify|continue|proceed|look|try|do (?:that|this|it))\b/i,
  /\bi['’]?ll (check|verify|continue|proceed|look|try|do (?:that|this|it)|keep going|get (?:on|right) (?:on|to))/i,
  /\b(continuing|proceeding|working on it|moving on)\b.*[!.]?\s*$/i,
];

// Resolve the agent's allowed_tools list from a thread id. Best-effort: empty
// list if the thread or agent config has gone away (the validator then
// flags any `(via foo)` citation as unregistered, which is the safe default).
function lookupAllowedToolsForThread(thread_id: string): string[] {
  try {
    const thread = getThread(thread_id);
    if (!thread) return [];
    const agentCfg = getAgentConfig(thread.agent_id);
    if (!agentCfg) return [];
    const parsed = JSON.parse(agentCfg.tools) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export function looksLikeStall(text: string): boolean {
  // Inspect the last paragraph / sentence \u2014 earlier acknowledgment
  // language is fine when followed by real work. The stall signal is when
  // the message ends on a promise.
  const tail = text.split(/\n{2,}|(?<=[.!?])\s+/).filter(Boolean).slice(-2).join(" ");
  return STALL_PATTERNS.some((re) => re.test(tail));
}

// Run semantic recall on the user's turn, format the top hits as a system-prompt
// block. Empty string when no embeddings configured or no good matches.
async function buildRecallContext(
  current_thread_id: string,
  query: string,
  windowOldestContent: string | null,
): Promise<string> {
  if (!query.trim()) return "";
  let hits: RecalledMemory[];
  try {
    hits = await recall(query, 6);
  } catch {
    return "";
  }
  if (hits.length === 0) return "";

  // Drop matches that already live in the in-prompt history window.
  const filtered = hits.filter((h) => {
    if (h.source === "message" && h.thread_id === current_thread_id) {
      // crude but cheap: skip if it's the same content as anything in the window
      return windowOldestContent !== h.content;
    }
    return true;
  });
  if (filtered.length === 0) return "";

  const lines = [
    "--- Your retrieved memory for this turn ---",
    "These entries were pulled from YOUR own memory store (not user-supplied just now).",
    "Treat them as facts you previously committed to remember. Cite them confidently when relevant.",
    "",
  ];
  for (const h of filtered) {
    const stamp = h.created_at.slice(0, 10);
    if (h.source === "memory") {
      lines.push(`• [memory ${h.namespace}/${h.key}, ${stamp}] ${truncate(h.content, 280)}`);
    } else {
      const tag = h.thread_id === current_thread_id ? "earlier this thread" : "past chat";
      lines.push(`• [${tag} · ${h.role}, ${stamp}] ${truncate(h.content, 280)}`);
    }
  }
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

export function shouldEmitChunk(
  chunkType: StreamChunk["type"],
  options?: StreamOptions,
): boolean {
  const includeTools = options?.filters?.include_tools ?? true;
  const includeThinking = options?.filters?.include_thinking ?? true;
  if (!includeTools && (chunkType === "tool_call" || chunkType === "tool_result")) return false;
  if (!includeThinking && chunkType === "thinking_delta") return false;
  return true;
}

export { contentText };
