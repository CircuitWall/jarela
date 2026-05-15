import { streamWithConfig } from "@/lib/agents/llm";
import type { StreamChunk, StreamOptions } from "@/lib/agents/base";
import type { ContentPart } from "@/lib/tools/types";
import { addMessage, getRecentMessagesWindow, getThread, touchThread } from "@/lib/stores/threads";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { getUserProfile } from "@/lib/stores/user-profile";
import { startScheduler } from "@/lib/scheduler";
import { recall, type RecalledMemory } from "@/lib/embeddings";
import { listIntegrations } from "@/lib/stores/integrations";

export class RunThreadError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface PreparedThreadRun {
  stream: AsyncIterable<StreamChunk>;
  thread_id: string;
}

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
  addMessage(thread_id, "user", stored);
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
  const userCtx = userProfile && (userProfile.name || userProfile.about)
    ? `--- User context ---\n${userProfile.name ? `Name: ${userProfile.name}\n` : ""}${userProfile.about ? `About: ${userProfile.about}` : ""}`.trim()
    : null;

  const timeCtx = `Current time: ${new Date().toISOString()} (UTC). Use this when computing scheduled task timestamps.`;

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
      return [`${i.name}: configured.`];
    }),
    "",
  ].join("\n") : "";

  const capabilitiesCtx = [
    "--- Host UI capabilities (LangGUI) ---",
    "You're running inside LangGUI, a local web app. The surrounding UI provides:",
    "- Browser notifications (Web Notifications API) — fire automatically when you finish a turn or a scheduled task runs, IF the user has granted notification permission AND is not currently looking at this agent's chat.",
    "- A scheduled-tasks panel — users can see/cancel anything you schedule via schedule_task in the gear menu under \"Tasks\".",
    "- Per-agent thread persistence with checkpointed state.",
    "Don't tell users you can't notify them or that scheduling has no effect — both are wired and working.",
    "",
  ].join("\n");

  const planFirstCtx = [
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
    "ANTI-FABRICATION RULES (very important):",
    "- NEVER report a tool result you didn't actually receive. If you didn't call the tool, you have no result.",
    "- NEVER invent IDs, UUIDs, timestamps, status fields, or any structured value that should come from a tool's JSON output. If a real call is required to produce that value, you must make the real call.",
    "- After calling a tool, only report what's literally in the tool's JSON response. Don't paraphrase IDs or restate computed fields you didn't see.",
    "- If a tool errored, say so plainly and stop. Do not retry the same tool call with the same arguments. Do not pretend the call succeeded.",
    "- For `schedule_task` specifically: the response will contain `proposal_id` only if propose_config_change was used, or `id` + `next_run_at` from schedule_task. Quote those values verbatim. If you didn't call the tool, you don't have an id.",
  ].join("\n");

  const selfConfigCtx = [
    "--- Self-configuration (with user approval) ---",
    "If completing the user's task would clearly benefit from a config change, you may propose it.",
    "Available kinds (via propose_config_change):",
    "  - install_mcp: install a new MCP server. Prefer registry_id (e.g. 'github', 'atlassian') over a custom spec. " +
    "Do NOT include real secrets in the payload — use placeholder values and ask the user to fill them in the UI before approving.",
    "  - toggle_mcp: enable/disable an installed MCP server.",
    "  - update_agent_tools: change THIS agent's tool allowlist (agent_id = the current agent).",
    "  - update_agent: edit identity, instructions, or history window for an agent.",
    "Rules:",
    "- Only propose changes when the user's request makes them necessary or clearly helpful — don't volunteer changes unprompted.",
    "- After calling propose_config_change, end your turn with one short sentence telling the user what you proposed and that they need to approve it in the banner above the input.",
    "- Do not retry a failed proposal in the same turn — the user will see the banner.",
    "- Do not poll check_proposal in a tight loop. If you need to know the outcome, do it in the next turn after the user replies.",
    "",
  ].join("\n");

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
  const oldestInWindow = history.length > 0 ? contentText(history[0].content) : null;
  const recallCtx = await buildRecallContext(thread_id, trimmed, oldestInWindow);

  const presentationCtx = [
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

  const systemParts = [agentCfg.identity, agentCfg.instructions, userCtx, integrationsCtx, capabilitiesCtx, planFirstCtx, presentationCtx, timeCtx, selfConfigCtx, memoryCtx, recallCtx].filter(Boolean);
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

  return {
    stream: streamWithConfig(thread_id, history, streamOpts, signal),
    thread_id,
  };
}

export function persistAssistantMessage(thread_id: string, content: string): void {
  if (content.trim()) addMessage(thread_id, "assistant", content);
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
