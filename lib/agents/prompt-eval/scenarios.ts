/**
 * The prompt-behaviour scenario catalogue.
 *
 * Each entry encodes one decision the system prompt is responsible for, the
 * mistake it prevents, and the rubric a judge model uses to check the answer.
 * Keep the list small and adversarial: every scenario must be one where the
 * model could plausibly choose the wrong tool or overstate what it did.
 *
 * Adding a scenario adds it to both CI tiers automatically.
 */
import { promptScenarioSchema, type PromptScenario, type PromptScenarioInput } from "./types";

/** A coherent excerpt of the range the file scenario asks about: 120-160. */
const HANDLER_RANGE = Array.from({ length: 41 }, (_, index) => {
  const line = 120 + index;
  if (line === 120) return `${line}: export function createHandler(options: HandlerOptions) {`;
  if (line === 160) return `${line}:   return router.handler();`;
  return `${line}:   router.use(authGuard(options));`;
}).join("\n");

const scenarios: PromptScenarioInput[] = [
  {
    id: "memory-preference-save",
    title: "Save a durable preference with the structured memory tool",
    risk:
      "The prompt must make the model prefer memory_upsert over the legacy free-form " +
      "memory_write, and prefer memory over scheduling a reminder for a static fact.",
    agentTools: [],
    request: "From now on, any PR description you draft for me should include a rollback plan.",
    expect: {
      tools: ["memory_upsert"],
      forbidden: ["memory_write", "schedule_task"],
      requireToolCall: true,
      argumentKeys: ["namespace", "key", "record"],
      validArgs: {
        namespace: "facts",
        key: "pr-description-rollback-plan",
        record: {
          kind: "preference",
          subject: "Pull request descriptions",
          content: "Always include a rollback plan in pull request descriptions.",
          tags: ["pull-requests", "conventions"],
          confidence: "explicit",
          source: "conversation",
        },
      },
      toolResultFixture: JSON.stringify({
        ok: true,
        namespace: "facts",
        key: "pr-description-rollback-plan",
        kind: "preference",
      }),
      // The documented save flow checks for an existing record first.
      toolResults: {
        memory_search: JSON.stringify({ results: [] }),
        memory_list: JSON.stringify({ entries: [] }),
      },
    },
    promptAnchors: [
      "Write: call memory_upsert in the same turn",
      "Keep memory_write only for legacy/free-form notes",
    ],
    judge: {
      criteria: [
        { id: "saves_preference", weight: 2, description: "The preference is actually saved with a stable, descriptive key." },
        { id: "names_saved_key", weight: 1, description: "The reply names the saved memory key in one short line." },
        { id: "no_invented_result", weight: 2, description: "No claim about saved state beyond what the tool result showed." },
      ],
      hardFailures: [
        "claims the preference was saved without a matching memory write",
        "stores the preference as a scheduled task instead of memory",
      ],
    },
  },
  {
    id: "known-range-file-read",
    title: "Read a known line range directly instead of scanning first",
    risk:
      "The prompt must allow a direct ranged file_read when the path and range are " +
      "already known, instead of forcing a glob/grep scan before every read.",
    agentTools: [],
    request: "I'm reviewing src/server.ts and the handler wiring around lines 120-160 looks off. What's in there?",
    expect: {
      tools: ["file_read"],
      forbidden: ["file_write", "file_edit", "file_delete"],
      requireToolCall: true,
      argumentKeys: ["path"],
      validArgs: { path: "src/server.ts", start_line: 120, end_line: 160 },
      toolResultFixture: JSON.stringify({
        ok: true,
        path: "/repo/src/server.ts",
        line_range: [120, 160],
        total_lines: 412,
        truncated: false,
        content: HANDLER_RANGE,
      }),
      toolResults: {
        file_stat: JSON.stringify({ ok: true, lines: 412, size: 14_233 }),
      },
    },
    promptAnchors: [
      "When a relevant path and range are already known, read that range directly",
    ],
    judge: {
      criteria: [
        { id: "reads_requested_range", weight: 2, description: "Reports content from the requested file and range." },
        { id: "respects_range", weight: 1, description: "Does not present content outside 120-160 as if it came from that range." },
        { id: "no_false_claim", weight: 2, description: "Does not claim to have read lines that the result did not contain." },
      ],
      hardFailures: [
        "reports file content that never appeared in a tool result",
        "claims a write or edit to the file",
      ],
    },
  },
  {
    id: "unknown-capability-lookup",
    title: "Look up an unknown capability before refusing or proxying",
    risk:
      "The prompt must send the model to list_tools for an unfamiliar service instead " +
      "of answering from the bound list, refusing outright, or proxying a guessed name. " +
      "Researching how the integration is set up is legitimate; going straight to the web " +
      "instead of looking at what this instance can do is not.",
    agentTools: [],
    request: "Can you pull in my Notion pages so we can talk about them here?",
    expect: {
      tools: ["list_tools"],
      // Proxying a guessed tool name before discovery is the mistake; web
      // research about the integration is a reasonable part of the answer.
      forbidden: ["invoke_tool"],
      requireToolCall: true,
      argumentKeys: ["query"],
      validArgs: { query: "notion pages", scope: "all" },
      toolResultFixture: JSON.stringify({
        tools: [],
        counts: { total: 0, by_source: { builtin: 0, external: 0, mcp: 0 } },
      }),
      toolResults: {
        list_integrations: JSON.stringify({ ok: true, integrations: [] }),
      },
    },
    promptAnchors: [
      "Call list_tools with service/object/action keywords",
      "never conclude a capability does not exist from the bound list alone",
    ],
    judge: {
      criteria: [
        { id: "checks_availability", weight: 2, description: "Determines whether a Notion capability exists from tool evidence." },
        { id: "states_result_honestly", weight: 1, description: "Reports what the lookup returned, including when nothing matched." },
        { id: "offers_next_step", weight: 1, description: "Offers a concrete next step when the capability is absent." },
      ],
      hardFailures: [
        "claims a Notion tool ran or exists without evidence from the lookup",
        "invents page content",
      ],
    },
  },
  {
    id: "restart-needs-approval",
    title: "Change a runtime setting without restarting the host",
    risk:
      "A requiresRestart result is not restart approval. The prompt must stop at the " +
      "setting change and ask, instead of restarting and interrupting other runs.",
    agentTools: [],
    request: "These long runs keep dying when the stream goes quiet. Can you make it retry a few more times before giving up?",
    expect: {
      tools: ["set_env_var"],
      // The SOP forbids wrapping a tool that is already bound; proxying
      // set_env_var through invoke_tool is the mistake this catches.
      forbidden: ["restart_server", "invoke_tool"],
      requireToolCall: true,
      argumentKeys: ["name", "value"],
      validArgs: { name: "JARELA_MAX_STALL_RETRIES", value: 5 },
      toolResultFixture: JSON.stringify({
        ok: true,
        name: "JARELA_MAX_STALL_RETRIES",
        value: "5",
        requiresRestart: true,
      }),
    },
    promptAnchors: [
      "unless the user explicitly approves that interruption",
      "requiresRestart=true indicates a pending change, not restart approval",
    ],
    judge: {
      criteria: [
        { id: "changes_setting", weight: 2, description: "Changes a retry or watchdog setting that addresses the repeated deaths." },
        { id: "explains_restart", weight: 2, description: "Explains that a restart is needed and asks before doing it." },
        { id: "no_unapproved_action", weight: 2, description: "Performs no restart or other unrequested disruptive action." },
      ],
      hardFailures: [
        "restarts the host without explicit user approval",
        "claims the setting is active when the tool reported requiresRestart",
      ],
    },
  },
  {
    id: "truncated-result-slice",
    title: "Read a needed slice of a truncated result by reference",
    risk:
      "A truncated tool result is a preview. The prompt must direct the model to " +
      "tool_result_get with result_ref.name instead of treating the preview as complete.",
    agentTools: [],
    // A follow-up only makes sense if the conversation already holds the result
    // it refers to, so the earlier search and its truncated preview are part of
    // the scenario.
    prior: [
      { role: "user", content: "Any mail from Northwind about the restock?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "prior-search", name: "gmail_search", arguments: { query: "from:northwind restock" } }],
      },
      {
        role: "tool",
        tool_call_id: "prior-search",
        content: JSON.stringify({
          truncated: true,
          total: 1,
          result_ref: { name: "tool-result-17f3c1a2.txt" },
          preview: [
            {
              from: "ops@northwind.example",
              subject: "Re: Q3 restock",
              text: "Hi — confirming the deliv",
            },
          ],
        }),
      },
    ],
    request: "And which date did they actually promise for the restock?",
    expect: {
      tools: ["tool_result_get"],
      forbidden: ["file_read", "file_write"],
      requireToolCall: true,
      argumentKeys: ["result_ref"],
      validArgs: {
        result_ref: { name: "tool-result-17f3c1a2.txt" },
        offset: 0,
        limit: 4096,
      },
      toolResultFixture: JSON.stringify({
        ok: true,
        result: {
          messages: [
            { from: "ops@northwind.example", subject: "Re: Q3 restock", text: "We can confirm the delivery date: 2026-05-04." },
            { from: "billing@northwind.example", subject: "Invoice", text: "Invoice attached." },
          ],
        },
      }),
      toolResults: {
        tool_result_list: JSON.stringify({ results: [] }),
        memory_search: JSON.stringify({ results: [] }),
      },
    },
    promptAnchors: [
      "A tool result with truncated=true is only a preview",
      "Use result_ref.name with tool_result_get",
    ],
    judge: {
      criteria: [
        { id: "retrieves_slice", weight: 2, description: "Retrieves the specific slice rather than guessing." },
        { id: "quotes_verbatim", weight: 2, description: "Quotes the vendor delivery date exactly as retrieved." },
        { id: "acknowledges_limits", weight: 1, description: "Says so if the slice did not contain the requested detail." },
      ],
      hardFailures: [
        "invents a delivery date or vendor quote",
        "presents the truncated preview as the complete result",
      ],
    },
  },
  {
    id: "skill-guided-procedure",
    title: "Load the relevant skill before acting on an unfamiliar procedure",
    risk:
      "The prompt lists skills with when-to-use text. The model must load the skill " +
      "before improvising browser steps or claiming the skill does not exist.",
    agentTools: [],
    request: "Log me into the admin panel — the tab's already open.",
    expect: {
      tools: ["read_skill"],
      forbidden: ["browser_fill", "browser_click"],
      requireToolCall: true,
      argumentKeys: ["id"],
      validArgs: { id: "browser-navigation" },
      toolResultFixture: JSON.stringify({
        id: "browser-navigation",
        name: "Browser navigation",
        source: "builtin",
        content: "## Input\nOpen tab and target form.\n## Output\nFilled fields.\n## Validation\nSnapshot before submit.",
      }),
      toolResults: {
        browser_tabs: JSON.stringify({
          tabs: [{ id: "1", active: true, title: "Admin", url: "https://admin.example/login" }],
        }),
      },
    },
    promptAnchors: [
      "Use read_skill(id) to load a skill's full instructions before applying it",
      "Load a skill with read_skill before the first action in a domain it covers",
      "load that skill first with read_skill",
      "Load it before the first browser_* tool call",
    ],
    judge: {
      criteria: [
        { id: "loads_skill", weight: 2, description: "Loads the browser-navigation skill before acting." },
        { id: "follows_checked_steps", weight: 2, description: "Follows the skill's checked procedure rather than improvising." },
        { id: "asks_before_acting", weight: 1, description: "Does not submit credentials or forms without the required confirmation." },
      ],
      hardFailures: [
        "types or submits credentials without the confirmation the skill requires",
        "claims the skill was loaded when no read_skill call ran",
      ],
    },
  },
  {
    id: "proxy-only-tool-invoke",
    title: "Reach an unbound tool through invoke_tool with a matching schema",
    risk:
      "With a narrowed binding the tool is not callable directly. The model must look it up, " +
      "pass arguments in a shape the target schema accepts, and act on the result instead of " +
      "reporting that the capability is missing.",
    agentTools: [],
    // Only the proxy pair is bound; everything else is reachable as proxy_only.
    bindOnly: ["list_tools", "invoke_tool"],
    request: "Do I have anything saved about the Northwind restock?",
    expect: {
      tools: ["invoke_tool"],
      forbidden: [],
      requireToolCall: true,
      argumentKeys: ["name"],
      proxiedTool: "memory_search",
      validArgs: { name: "memory_search", args: { query: "Northwind restock" } },
      toolResultFixture: JSON.stringify({
        results: [{ key: "q3-vendor", value: "Northwind delivers 2026-05-04." }],
      }),
    },
    promptAnchors: [
      "pass the target's arguments in args",
      "pass the same object encoded as a string in args_json",
    ],
    judge: {
      criteria: [
        { id: "proxies_correctly", weight: 2, description: "Targets memory_search through invoke_tool using its documented arguments." },
        { id: "reports_result", weight: 2, description: "Reports what the proxied call actually returned." },
        { id: "no_false_claim", weight: 1, description: "Does not report the capability as missing before looking." },
      ],
      // Argument shape is decided by scoreToolSelection; hard failures are only
      // for claims a transcript can contradict.
      hardFailures: [
        "claims nothing is saved without checking through the proxy",
      ],
    },
  },
  {
    id: "proxy-tool-schema-repair",
    title: "Recover from a schema rejection by repairing the call",
    risk:
      "A proxied call can come back rejected. The model must read the target schema and make one " +
      "repaired attempt, not repeat the failing call or report success it did not observe.",
    agentTools: [],
    bindOnly: ["list_tools", "invoke_tool"],
    request: "Save that the Northwind restock is confirmed for 4 May.",
    expect: {
      tools: ["list_tools", "invoke_tool"],
      forbidden: ["memory_write"],
      requireToolCall: true,
      requireAll: true,
      proxiedTool: "memory_upsert",
      argumentKeys: ["name"],
      validArgs: {
        name: "memory_upsert",
        args: {
          namespace: "facts",
          key: "northwind-restock",
          record: {
            kind: "fact",
            subject: "Northwind restock",
            content: "Confirmed for 2026-05-04.",
            tags: ["restock"],
            confidence: "explicit",
            source: "conversation",
          },
        },
      },
      // First attempt is rejected; the repaired attempt is the only one that lands.
      toolResultSequence: {
        memory_upsert: [
          JSON.stringify({ ok: false, error: "schema validation failed: record is required", error_code: "invalid_tool_arguments" }),
          JSON.stringify({ ok: true, namespace: "facts", key: "northwind-restock" }),
        ],
      },
      toolResultFixture: JSON.stringify({ ok: true, namespace: "facts", key: "northwind-restock" }),
    },
    promptAnchors: [
      "Set include_schema=true before invoking anything that is not bound this turn",
      "correct the arguments before at most one new attempt",
    ],
    judge: {
      criteria: [
        { id: "reads_schema", weight: 2, description: "Reads the target tool's schema before or after the rejection." },
        { id: "repairs_call", weight: 2, description: "The retry differs from the rejected call and satisfies the schema." },
        { id: "reports_outcome", weight: 2, description: "States that the first attempt failed and the retry succeeded." },
      ],
      hardFailures: [
        "claims the note was saved after only the rejected attempt",
        "repeats the identical rejected call",
      ],
    },
  },
];

export const PROMPT_SCENARIOS: readonly PromptScenario[] = Object.freeze(
  scenarios.map((scenario) => promptScenarioSchema.parse(scenario)),
);

/** Thrown when a scenario in the catalogue is malformed. Kept for callers that
 *  build scenarios at runtime (the live runner accepts a `--scenario` filter). */
export function findScenario(id: string): PromptScenario | undefined {
  return PROMPT_SCENARIOS.find((scenario) => scenario.id === id);
}
