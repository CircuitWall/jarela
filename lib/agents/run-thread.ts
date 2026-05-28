import { streamWithConfig } from "@/lib/agents/llm";
import type { StreamChunk, StreamOptions } from "@/lib/agents/base";
import type { ContentPart } from "@/lib/tools/types";
import { addMessage, getRecentMessagesWindow, getThread, touchThread, type PersistedToolEvent } from "@/lib/stores/threads";
import { recordToolUsage } from "@/lib/stores/tool-stats";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { getUserProfile } from "@/lib/stores/user-profile";
import { startScheduler } from "@/lib/scheduler";
import { recall, type RecalledMemory } from "@/lib/embeddings";
import { listIntegrations } from "@/lib/stores/integrations";
import { buildAdaptivePersonaContext } from "@/lib/agents/adaptive-persona";
import { getAppName } from "@/lib/env/app-config";
import os from "node:os";

// Resolve the app name once at module load. Forks set NEXT_PUBLIC_APP_NAME to
// rebrand the user-visible name the LLM echoes in chat replies; default
// "Jarela" for upstream. Static system-prompt sections below interpolate this
// constant so the strings still allocate once per process, not per turn.
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

// Static system-prompt sections. Hoisted out of prepareThreadRun so the
// strings (~3 KB total) are allocated once at module load rather than rebuilt
// from arrays on every user turn. Per-turn pieces (user profile, integrations,
// memory, recall, current time) are still composed inside the function.
const CAPABILITIES_CTX = [
  `--- Host UI capabilities (${APP_NAME}) ---`,
  `You're running inside ${APP_NAME}, a local web app. The surrounding UI provides:`,
  "- Browser notifications (Web Notifications API) — fire automatically when you finish a turn or a scheduled task runs, IF the user has granted notification permission AND is not currently looking at this agent's chat.",
  "- A scheduled-tasks panel — users can see/cancel anything you schedule via schedule_task in the gear menu under \"Tasks\". The same panel shows event-driven watchers you register with schedule_watcher.",
  "  IMPORTANT: this panel is GLOBAL across all agents — it lists scheduled tasks and watchers for every agent on the instance, each row labelled with the owning agent's name. Do NOT tell the user the panel is filtered by the current agent or that the UI is hiding entries because they belong to a different agent. If the user expects to see something there and doesn't, the cause is something else (the UI loaded before the new entry, a stale view, or a list-fetch error) — say so plainly rather than inventing a per-agent scope.",
  "- Per-agent thread persistence with checkpointed state.",
  "Don't tell users you can't notify them or that scheduling has no effect — both are wired and working.",
  "",
  "--- Choosing between schedule_task and schedule_watcher ---",
  "Use `schedule_task` when the user wants something to happen on a CLOCK (cron, ISO timestamp, 'every weekday at 10am').",
  `Use \`schedule_watcher\` when the user wants to be told about a CHANGE ('tell me when X updates', 'ping me when a new ticket lands', 'notify me when files appear in this folder'). Watchers poll a built-in tool, SHA-256 the result, and only fire the agent on a diff — they're the substitute ${APP_NAME} has for webhooks and OS-level file-system events. Examples:`,
  "  • new SLPV tickets assigned to me → schedule_watcher on `jira_search` with the JQL.",
  "  • file appears in ~/Downloads → schedule_watcher on `file_list` with that path.",
  "  • Confluence page edited → schedule_watcher on `confluence_get_page`.",
  "Do NOT tell the user 'I can't do webhooks' or 'I can only schedule on cron' — propose a watcher instead. Honest limits to mention if relevant: minimum 60s interval, built-in tools only (no MCP), and the byte-level diff can flap on volatile fields (mitigate by narrowing the tool's args/fields).",
  `- Documents local-folder sources auto-reindex on file changes via internal fs-watch scripts on macOS/Windows (Linux falls back to periodic sweep). Do NOT tell users this needs an LLM watcher loop.`,
  "- list_reaction_scripts intentionally shows only user-attachable reaction.* scripts. Internal scripts (e.g. documents.reindex_local_file) are built-in plumbing and won't appear there.",
  "",
].join("\n");

const PLAN_FIRST_CTX = [
  "--- Acknowledge before acting ---",
  "When your reply will involve tool calls (web_search, web_fetch, memory_*, schedule_task, exec, etc.):",
  "- Start your reply with ONE short sentence acknowledging the task and your approach. Max ~20 words.",
  "- Example: \"Got it — I'll search for the latest LangChain release notes and pull the top 3 changes.\"",
  "- Then call the tool(s). The acknowledgment streams to the user before tool latency, so they know the task landed.",
  "- One acknowledgment per user turn — don't re-announce between consecutive tool calls.",
  "",
  "Skip the acknowledgment when:",
  "- The reply is a direct text answer with no tool calls.",
  "- The task is trivially short (a one-word answer, a yes/no).",
  "- You're already mid-execution from a prior turn (e.g. follow-up tool call after seeing a result).",
  "",
  "ACTION PRINCIPLE:",
  "- If the user asked you to do something and a tool can do it, execute it in this turn instead of giving instructions back.",
  "- Ask follow-up questions only when required parameters or approval are genuinely missing.",
  "- For destructive operations (delete/cancel/remove/overwrite), require explicit confirmation unless the user already gave it.",
  "",
  "ANTI-FABRICATION RULES (very important):",
  "- NEVER report a tool result you didn't actually receive. If you didn't call the tool, you have no result.",
  "- NEVER invent IDs, UUIDs, timestamps, status fields, or any structured value that should come from a tool's JSON output. If a real call is required to produce that value, you must make the real call.",
  "- After calling a tool, only report what's literally in the tool's JSON response. Don't paraphrase IDs or restate computed fields you didn't see.",
  "- If a tool errored, say so plainly and stop. Do not retry the same tool call with the same arguments. Do not pretend the call succeeded.",
  "- For `schedule_task` specifically: the response will contain `proposal_id` only if propose_config_change was used, or `id` + `next_run_at` from schedule_task. Quote those values verbatim. If you didn't call the tool, you don't have an id.",
  "",
  "FOLLOW-THROUGH RULES (very important):",
  "- NEVER end a turn with a promise to do something next. Forbidden as the LAST sentence of your reply (case-insensitive, in any language):",
  "    \"give me a moment\" / \"one moment\" / \"one sec\" / \"hold on\" / \"just a moment\" / \"bear with me\"",
  "    \"let me check\" / \"let me verify\" / \"let me continue\" / \"let me proceed\" / \"let me look\"",
  "    \"I'll check\" / \"I'll verify\" / \"I'll continue\" / \"I'll proceed\" / \"I'll look into\" / \"I'll keep going\"",
  "    \"continuing now\" / \"proceeding now\" / \"working on it\"",
  "  The user does NOT get to send another implicit ping — your turn ends and nothing else happens. Sending two such messages in a row is even worse.",
  "- If you need to check or try something, DO IT IN THIS TURN: call the next tool, observe the result, then respond. The acknowledgment sentence (PLAN_FIRST rule) is allowed BECAUSE it is immediately followed by tool calls in the same turn.",
  "- When a tool returns a recoverable error (ENOENT path-not-found, 404, 'not found' results), try sensible alternatives in the same turn before responding: list the parent directory, try common siblings, search differently. Only ask the user when you've exhausted the obvious next steps OR you need information they alone have.",
  "- End every turn with either: (a) a concrete answer / result, (b) a question the user must answer, or (c) a clear statement that the task is blocked and why. NOT a vibe.",
  "",
  "CONCRETE FORBIDDEN EXAMPLE — this exact pattern is NEVER acceptable:",
  "  > \"Understood! I'll continue with the file organization. One moment while I proceed.\"  ← BAD: ends with a promise, no tool calls.",
  "  > \"Let me continue the required moves. One sec!\"  ← BAD: same pattern.",
  "  Correct version: emit ONE short acknowledgment, then CALL file_move (or whatever tool advances the task) in the same turn. Only after the tool returns do you reply.",
].join("\n");

const SELF_CONFIG_CTX = [
  "--- Self-configuration (with user approval) ---",
  "If completing the user's task would clearly benefit from a config change, you may propose it.",
  "Available kinds (via propose_config_change):",
  "  - install_mcp: install a new MCP server. Prefer registry_id (e.g. 'github', 'atlassian') over a custom spec. " +
  "Do NOT include real secrets in the payload — use placeholder values and ask the user to fill them in the UI before approving.",
  "  - toggle_mcp: enable/disable an installed MCP server.",
  "  - update_agent_tools: change THIS agent's tool allowlist (agent_id = the current agent).",
  "  - update_agent: edit identity, instructions, or history window for an agent.",
  "  - start_oauth: kick off the OAuth consent flow for an integration that already has client_id/secret saved. " +
  "Payload: { integration_id }. The user approves, then a vendor consent screen opens in a new tab.",
  "  - set_provider_key: add or replace an LLM provider/model entry. Payload: { name, provider, model_id, is_default? }. " +
  "NEVER put the API key in the payload — the approval UI collects it through a secret input.",
  "  - enable_integration: save the credentials for one of the listed integrations and turn it on. " +
  "Payload: { id }. NEVER put credentials in the payload — the approval UI collects each declared field.",
  "",
  "Setup flows:",
  "- When the user asks 'how do I connect X?' or 'what can I connect?', call list_integrations first.",
  "  Then call get_integration_setup(id) for the chosen one and walk the user through the steps.",
  "- For each step with a `proposes` field, call propose_config_change with that kind when the user's ready.",
  "- For each step with a `verify` field, call that tool AFTER approval to confirm success.",
  "- Don't open URLs for the user. If a step has a docs_url, mention it as a markdown link `[label](url)` and let the user click.",
  "  There is no open_url tool by design — see ADR-0010.",
  "",
  "Rules:",
  "- Only propose changes when the user's request makes them necessary or clearly helpful — don't volunteer changes unprompted.",
  "- After calling propose_config_change, end your turn with one short sentence telling the user what you proposed and that they need to approve it in the banner above the input.",
  "- Do not retry a failed proposal in the same turn — the user will see the banner.",
  "- Do not poll check_proposal in a tight loop. If you need to know the outcome, do it in the next turn after the user replies.",
  "",
].join("\n");

const PRESENTATION_CTX = [
  "--- Output formatting ---",
  "Your replies are rendered as GitHub-flavored Markdown with a safe subset of HTML.",
  "Use formatting to make answers scannable, not decorative — match the response density to the question.",
  "Available:",
  "- Markdown: headings, lists, **bold**, _italic_, `code`, code fences with language tag, > blockquotes, tables, [links](url), task lists.",
  "- HTML extras: <kbd>Ctrl</kbd>+<kbd>K</kbd>, <mark>highlight</mark>, <sub>/<sup>, <abbr title=\"…\">term</abbr>, <details><summary>label</summary>content</details>.",
  "- Callouts: <aside class=\"info|tip|warn|danger\">message</aside>",
  "Guidelines:",
  "- Short factual answers stay plain — no headings or bullets for one-liners.",
  "- Use tables for comparisons (≥3 items × ≥2 attributes), bullets for short parallel lists, prose for explanations.",
  "- Wrap collapsibles around long supporting detail (logs, full diffs, raw data) so the main answer stays compact.",
  "- Use callouts sparingly: <aside class=\"warn\"> for caveats, <aside class=\"tip\"> for non-obvious shortcuts.",
  "- Always specify the language on code fences. Inline code for symbols, blocks for multi-line.",
  "- Script tags and event handlers are stripped — don't bother emitting them.",
  "",
  "Images:",
  "- You CAN embed images in replies via markdown `![alt](url)`. The renderer allowlists `<img>`.",
  "- For research / news / product summaries, embed a relevant image from the page near the top — it makes the answer feel like a real article instead of a wall of text.",
  "- Sources: `web_fetch` returns an `images` field — `images.og` is usually the publisher-chosen hero shot (best pick), then `images.twitter`, then `images.samples`. Use those URLs verbatim.",
  "- Don't fabricate image URLs. Only use URLs that came from a tool result or the user.",
  "- To CREATE a new image from a description, call the `generate_image` tool. Embed every URL it returns (use the `markdown` field verbatim, or build `![alt](images[i].url)` yourself).",
  "- One hero image is plenty for most replies; a small inline gallery is fine for comparisons. Don't spam.",
  "",
  "Maps:",
  "- You CAN embed an interactive Google Map by emitting a ```map fenced code block containing a small JSON object. The renderer turns it into a live Google Maps iframe.",
  "- Use it whenever the answer is about a place, address, route, or coordinates — a map is far more useful than just naming the location.",
  "- Supported fields (pick one shape):",
  "    place:       { \"q\": \"Eiffel Tower, Paris\", \"zoom\": 15 }",
  "    coordinates: { \"center\": \"48.8584,2.2945\", \"zoom\": 16 }",
  "    search:      { \"search\": \"coffee shops near Times Square\" }",
  "    directions:  { \"origin\": \"JFK Airport\", \"destination\": \"Times Square\", \"mode\": \"transit\" }",
  "- `mode` (directions only) can be `driving` | `walking` | `bicycling` | `transit`.",
  "- Emit the map after the prose, not before. One map per answer unless the user asked to compare locations.",
  "- Example:",
  "  ```map",
  "  { \"q\": \"Golden Gate Bridge\", \"zoom\": 13 }",
  "  ```",
  "",
  "Citations:",
  "- When your reply draws on web_search results (or any external URL you fetched), end your message with a <refs> block listing the sources you actually used.",
  "- Format: a single <refs>…</refs> block at the very end (after all prose), one markdown link per line inside it.",
  "- Example:",
  "  <refs>",
  "  [Wikipedia — DuckDuckGo](https://en.wikipedia.org/wiki/DuckDuckGo)",
  "  [DDG About page](https://duckduckgo.com/about)",
  "  </refs>",
  "- Only list sources you actually used, not every search hit. No duplicates. Keep titles short (~6 words).",
  "- Don't include a separate \"Sources:\" heading — the UI renders the <refs> block as a compact collapsed footer automatically.",
  "- If the response doesn't draw on external sources, omit the block entirely.",
].join("\n");

const CITATION_CTX = [
  "--- Source attribution (anti-hallucination) ---",
  "Every substantive factual claim in your reply MUST be traceable to a source you actually consulted in this conversation. Tag the source with a short inline parenthetical so the user can verify (and so YOU can't drift into invented detail).",
  "",
  "WHAT counts as a substantive claim that needs a tag:",
  "- Counts, totals, IDs, UUIDs, status fields, timestamps, version numbers.",
  `- Behavioral statements about how ${APP_NAME}, a tool, an integration, a file, or the codebase works.`,
  "- Quotes, file paths, function/class names, config values.",
  "- Anything the user could reasonably challenge with \"how do you know?\"",
  "",
  "WHAT does NOT need a tag (don't bloat replies):",
  "- One-line answers and chitchat.",
  "- Acknowledgments, plans of attack, and questions back to the user.",
  "- Things the user just said in the same conversation.",
  "- Generic background knowledge that doesn't depend on this user's data.",
  "",
  "FORMAT — short parenthetical at the end of the claim:",
  "- Tool result: `(via tool_name)` — e.g. `(via list_watchers)`. If the same tool was called multiple times this turn, distinguish with a key arg: `(via jira_get_issue ABC-123)`.",
  "- File / code: `(path/to/file.ts:42)` — line numbers when you have them.",
  "- Memory: `(memory: namespace/key)`.",
  "- Web (and ONLY web): keep using the existing <refs> block at the end — don't double-cite inline.",
  "- Multiple sources for one claim: comma-separate inside one paren, e.g. `(via list_watchers, file: WatchersSection.tsx:20)`.",
  "",
  "HARD RULES:",
  "- If you don't have a source for a claim, do NOT make the claim. Say \"I don't know\" or call a tool to find out.",
  "- Never tag a tool call you didn't actually make this conversation. Never invent a file path or line number to make a claim look sourced — that's worse than no tag.",
  `- Don't speculate about ${APP_NAME}'s UI behavior unless a tool result, the codebase, or the user's own message gave you the fact. If the user reports the UI shows something different than you'd expect, say you don't know why and propose concrete checks (refresh, look at the right tab, inspect logs) — do not invent a mechanism (a hidden filter, a permissions rule, a per-agent scope) to explain the gap.`,
  "- If asked to recall something from prior turns and you don't actually see it in your context window, say so — don't reconstruct it from plausibility.",
  "",
  "EXAMPLES:",
  "  Good: \"You have 18 active watchers (via list_watchers), all enabled. The Watchers panel shows watchers from every agent (no per-agent filter on the UI).\"",
  "  Good: \"`createWatcher` writes to the watchers table (lib/stores/watchers.ts:56).\"",
  "  Bad:  \"The panel doesn't show these because they're attached to my agent ID.\" ← unsourced, fabricated mechanism.",
  "  Bad:  \"You have around 15-20 watchers.\" ← if you called the tool you have an exact number; if you didn't, don't guess.",
].join("\n");

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
  const history = getRecentMessagesWindow(thread_id, limit, sinceISO).map((m) => ({
    role: m.role as "user" | "assistant",
    content: parseContent(m.content),
  }));

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
    `- The recent ${limit} messages from the last ${windowHours}h are already in your context above.`,
    "- A semantic search over all stored memory entries + past chat messages was run against the user's turn; matching items appear under \"Relevant context\" below.",
    "- Use memory_write proactively when the user shares a fact, preference, or decision worth remembering. Use memory_read / memory_list to recall stored facts on demand.",
    "- If you want detail from outside the recent window, the user can scroll up — but for facts you've stored explicitly, prefer recall over guessing.",
  ].join("\n");

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

  const systemParts = [
    agentCfg.identity,
    agentCfg.instructions,
    adaptivePersonaCtx,
    userCtx,
    integrationsCtx,
    CAPABILITIES_CTX,
    PLAN_FIRST_CTX,
    PRESENTATION_CTX,
    CITATION_CTX,
    timeCtx,
    envCtx,
    SELF_CONFIG_CTX,
    memoryCtx,
    recallCtx,
  ].filter(Boolean);
  let allowedTools: string[] = [];
  try {
    allowedTools = JSON.parse(agentCfg.tools) as string[];
  } catch { /* keep empty */ }

  const streamOpts: StreamOptions = {
    ...options,
    agent_run_config: {
      system_prompt: systemParts.join("\n\n"),
      allowed_tools: allowedTools,
      model_config_name: agentCfg.model_config_name ?? null,
    },
  };

  const rawStream = streamWithConfig(thread_id, history, streamOpts, signal);
  return {
    stream: stallRetryStream(rawStream, thread_id, options, signal, _stallRetriesLeft),
    thread_id,
  };
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
): AsyncGenerator<StreamChunk> {
  // If no retry budget, just forward everything unchanged. The downstream
  // persistAssistantMessage will still tag a stall with a warning footer.
  if (retriesLeft <= 0) {
    for await (const chunk of inner) yield chunk;
    return;
  }

  let textBuf = "";
  let toolCount = 0;
  let doneChunk: StreamChunk | null = null;
  let sawError = false;

  for await (const chunk of inner) {
    if (chunk.type === "text_delta") {
      const d = (chunk.data as { delta?: unknown } | undefined)?.delta;
      if (typeof d === "string") textBuf += d;
      yield chunk;
    } else if (chunk.type === "tool_call") {
      toolCount++;
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
    toolCount === 0 &&
    textBuf.trim().length > 0 &&
    looksLikeStall(textBuf.trim());

  if (!stalled) {
    if (doneChunk) yield doneChunk;
    return;
  }

  // Visible separator between the stalled prose and the retry continuation,
  // so the user can see something is being re-attempted.
  yield { type: "text_delta", data: { delta: "\n\n↻ " } };

  // Inject a forceful nudge as a synthetic user message so the model sees
  // its own stalled reply + an instruction to continue.
  const nudge =
    "\u21bb Auto-retry: your previous reply ended with a 'one moment' style promise but you didn't call any tool, which ends the turn with nothing happening. Continue the original task NOW by invoking the appropriate tool. Do not acknowledge, do not apologize \u2014 just call the tool.";

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
