# Operating Jarela

Jarela's main operational views are available from the app menu. They let you review usage, inspect tool configuration, manage scheduled work, and continue agent conversations.

At viewport widths of 1280px and above, the menu stays open on the right
without covering the workspace. At 1536px and above, the agent selector also
expands into a scrollable left sidebar with agent names and unread indicators.
The sidebars stay fixed at 256px on the left and 320px on the right, while chat
fills all remaining width, including on ultrawide screens. Other views retain
their existing content-width limits.
On narrower screens, use the header's agent selector and Menu button.

**Jarela 3.0.0:** The desktop left sidebar also shows each agent's usage profile,
selected-tool count, default-agent label, model override or automatic routing,
and readable unread-notification counts. Above the docked right menu, a
**Selected agent** card shows the agent's icon (or initial), name, and
Markdown-rendered identity and instructions. Long descriptions scroll inside
the card, and empty identity/instruction fields are labeled explicitly.
Markdown headings, lists, emphasis, code, links, and tables are supported; raw
HTML is skipped and embedded images appear as their alternative text without
loading remote content. Configuration metadata stays in the left list rather
than being repeated in the right card. **Manage agents** opens the existing
Agents view. Selected tools are not a guarantee of runtime availability;
unavailable model overrides can fall back to automatic routing. No additional
API requests are made for the description. The desktop card also offers quick
**Model** selection (including **Automatic routing**), a **Usage strategy**
selector in Full mode, and **Enable voice**. Controls load the saved model list
only while the desktop card is available; disabled or missing model overrides
are labeled and cannot be newly selected. Each change saves immediately for
that agent across conversations, preserving other settings. Saving and failure
states are shown explicitly. Model/strategy changes affect new runs, not a
reply already in progress. Voice still requires a configured Google AI
integration for Gemini speech services; enabling it is not a readiness check.
Chat voice controls refresh after saving without a page reload. The additions
use the existing desktop breakpoints and sidebar widths; the mobile header and
small-screen menu drawer are unchanged.

![Wide-screen studio layout with the agent sidebar, workspace, and selected-agent controls](assets/operations-agents.png)

![Mobile-width Agents view in a simulated iPhone frame](assets/operations-mobile.jpg)

The app view was captured at a 390 CSS-pixel viewport. The device frame, status
bar, and home indicator are illustrative; this is not a screenshot of a
verified installed or standalone-mode iOS PWA.

## Manage agents

The Agents view lists configured agents with a short summary of each instruction set. Use **New** to start adding an agent, and review the selected agent's tools and instructions before relying on it for a workflow.

## Configure your profile

Profile settings hold the identity and context shared with agents, along with persona filters and the Essential or Full experience mode. Optional location sharing and Tailscale access controls are also managed here.

![Jarela Profile settings](assets/operations-profile.png)

## Advanced settings

Advanced settings are grouped into tabs for **Credentials**, **Models**, **Privacy & security**, **Appearance**, and **Networking**. Choose the relevant tab to review provider access, model configuration, privacy controls, visual preferences, or network exposure.

![Jarela advanced settings with credential and settings categories](assets/operations-advanced-settings.png)

### Skill execution consent policy (Unreleased)

In **Advanced settings > Privacy & security > Skill execution**, choose:

- **Blocked**: refuse skill scripts.
- **Ask each time** (default): require consent for each invocation.
- **Approve a workflow run**: require consent for a verified plan's declared steps
  and bounded repetitions, not arbitrary future work.
- **Trust selected revisions**: waive repeated invocation prompts only for an
  exact verified snapshot SHA-256 revision, agent ID and resolved absolute host
  workspace path, within the grant's timeout/output ceilings. Other revisions or
  scopes still require invocation consent.

Add/remove trust scopes in the draft, then save. Enabling listed trust requires
acknowledging that scripts have full host-file/network access as the app's OS user
and may receive different valid inputs. Trust persists across app restarts.
Changing code invalidates a revision match; removing trust or selecting Blocked
affects future launches, not code already running. A skill name or source-file
hash is not a verified snapshot identity.

Saving acknowledged trust creates an approval record with a server-issued ID
and UTC timestamp, shown beside the revision. The same checksum/agent/workspace
and grant ceilings reuse that record across saves and restarts; different valid
inputs do not require repeated prompts in trusted-revision mode. Declared version
labels alone are not sufficient. Changed code, scope or ceilings require a new
record. Entries saved outside trusted-revision mode remain drafts unless already
approved. Remove an entry and save to revoke it; re-adding needs fresh approval.
This list contains active approvals, not a retained history of revoked records.

Policy management is restricted to the local, unlocked app. Agents cannot change
it through memory tools or generic memory APIs. Safe mode always blocks scripts,
and execute capability remains required; neither mostly-safe nor bypass mode
implicitly approves a skill.

**Script execution is not available yet.** These settings persist consent policy
and evaluate requirements; they do not capture snapshots, execute code or supply
workflow approval. The checked runner and bounded workflow approval integration
remain pending under [ADR-0112](adr/0112-checked-javascript-skill-execution.md).

## Review usage

### Adaptive output budgets (Unreleased)

New turns use a text-size heuristic for output allocation: estimate the current
user text at roughly four characters per token, multiply that estimate by four
for headroom, and keep at least the strategy baseline (2,048 tokens for Fast
and Cost-saving; 4,096 for Balanced and High reasoning). Thinking models retain
a 32,768-token baseline outside Cost-saving, subject to hard limits. Explicit
thinking budgets also reserve room for output.

An explicit model `max_tokens` setting remains a ceiling, not a minimum.
Known model output limits and the run's context allocation can lower the
result. The selected amount is reserved before assembling conversation history.
Fast and Cost-saving output baselines can now grow for larger user turns;
these strategies are not hard spending limits.

This is an estimate based on text size, not a prediction of the requested
document length. Short requests can require long output; binary attachments,
earlier conversation, and later tool results do not increase the estimate.
The cap is selected once per turn, not recalculated for each tool step.
If the provider reports output-token truncation while generating tool calls,
the model step fails before those calls execute. Jarela reports an actionable
error instead of attempting a partial write; earlier completed tool steps are
not rolled back.

### Dashboard metrics

The Dashboard summarizes token use, estimated cost, cache activity, and tool reliability over a selectable time window. It also includes daily trends and model/provider breakdowns. Cost figures are estimates based on the configured pricing data, not billing statements.

**Jarela 3.0.0:** Costs are split into input and output using
each model's separate rates per
million tokens. The breakdown appears in summaries and daily, vendor, model, and
agent reports; prompt-cache read/write charges are included with input. When
matching rates are unavailable, recorded cost is shown as unattributed rather
than assigned an unsupported input/output split. Legacy messages use
content-length token estimates, and historical recorded totals are not rewritten.

Repeated dashboard computations reuse the last result for up to five seconds
when the database, pricing snapshot, date, and selected window are unchanged.
Database writes or pricing changes invalidate that server-side result. The
existing browser response cache can retain metrics for up to 30 seconds.

**Jarela 3.0.0:** The built-in `refresh_model_pricing` agent tool and weekly maintenance task also
check official API model documentation for rolling-version and capability
updates. Accepted observations include source URLs, check times, and supporting
quotes. Saved-model badges and catalog entries use this display metadata after
refetching; saved model IDs, credentials, request parameters, routing, and
historical costs remain unchanged. The Dashboard's **Refresh pricing** button
remains a pricing-only operation; ask an agent to run `refresh_model_pricing`
for the combined check.

Model updates use the existing pricing extractor configuration
(`JARELA_PRICING_LLM_EXTRACT` and `JARELA_PRICING_EXTRACTOR_MODEL`, otherwise the
default model). This makes additional calls to your configured model provider.
Disabled/unavailable extraction, documentation failures, and truncated sources
are reported, not treated as successful verification. Existing observations are
retained when a check fails or a capability is simply absent from a page.
First-observed models are newly tracked, not necessarily newly released.

Standalone provider APIs are kept separate from model capabilities: DeepSeek's
Search & Fetch APIs do not imply that Flash's chat endpoint performs native
search. The weekly agent reviews adoption candidates, checks existing GitHub
issues, and files a follow-up only when code work is confirmed and the agent
has source access, GitHub tools, credentials, and approval. It reports blockers
instead of claiming an issue was filed. Unmodified legacy weekly prompts are
upgraded persistently on their next firing or when setup is requested again;
customized prompts and schedules are preserved.

![Jarela usage dashboard with token, cost, and tool reliability summaries](assets/operations-dashboard.png)

## Inspect tools

The Tools view groups the catalog, installed packages, and internal runtime controls. Use it to review what is available to agents and the current package/runtime setup.

![Jarela Tools view with package and runtime sections](assets/operations-tools.png)

## Review scheduled work

The Tasks view separates scheduled tasks from event-driven tasks so each kind of background work can be reviewed in its own section.

If a scheduler tick fails before or during trigger dispatch, the server logs
`[scheduler] tick failed` and releases the in-flight guard so the next tick can
run. This does not mean an interrupted external action is safe to repeat;
inspect its outcome before manually retrying.

![Jarela Tasks view showing scheduled and event-driven tasks](assets/operations-tasks.png)

## Work in chat

### Personal briefing pilot

The built-in `personal-briefing` skill combines read-only source retrieval and
model drafting with `validate_personal_briefing`, a local read-only validator.
The validator checks draft structure, references against the supplied source
IDs, and disclosure of unavailable sources. It does not prove that the
sources were retrieved or that the summary is factually correct. Review the
original tool results and keep external actions separate.

Workflow checks are tested with representative synthetic inputs. A built-in
skill folder may include `tests/*.json` fixtures, each naming a checking tool,
an input, and the expected verdict (`ok`, plus optional `issue_paths` that must
be reported). `lib/skills/fixtures.test.ts` runs every fixture through the
real registered tool. A fixture that targets a tool without the `read`
capability fails without being invoked, so these tests cannot send, write, or
execute anything. The personal briefing ships happy-path, all-sources-down,
invented-source, hidden-outage, and misreported-gap cases. Fixtures prove the
checking code's verdicts, not live model behaviour.

### Conversations

Chat is the per-agent workspace for conversations and their results. Keep related follow-up work in the same thread so its existing context remains available.

An asynchronous tool handoff means work is still running, not that its effect
has been verified. The runtime keeps these calls out of successful-tool
evidence while retaining them in duplicate-effect protection.

At agent startup, the picker and chat share in-flight profile, agent config,
thread resolution, and recent-message reads. Successful startup responses are
reused for up to five seconds, with at most 16 entries retained in browser
memory. Explicit thread links warm the selected conversation instead of the
default one. Normal refreshes and pagination remain fresh; client writes and
run submissions invalidate startup data. This warmup makes no provider calls
and does not preload other agents or the full conversation history.

To time local embedding inference and memory search without opening user data
or calling a remote provider, install the local model first, then run in
PowerShell:

```powershell
$env:JARELA_BENCHMARK_EMBEDDINGS = "1"
npm test -- lib\embeddings\performance.test.ts --silent=false --reporter=verbose
Remove-Item Env:\JARELA_BENCHMARK_EMBEDDINGS
```

The opt-in benchmark disables model downloads and uses an in-memory SQLite
database. It reports cold pipeline initialization, warm inference, embedding
cache hits, and searches over 1,000 and 10,000 synthetic vectors. Repeated
vectors stress broad-match scanning/ranking rather than retrieval quality;
timings exclude HTTP transport and remote-provider latency. Cold cases have
one sample, so their p95 is not a statistically meaningful tail estimate.

Live context-summary polling reads metadata only, pauses while the page is
hidden, and waits for each request to finish before scheduling the next.
Historical chat rows are reused during streamed token updates; message edits,
filters, context boundaries, and load-older navigation still update normally.

![Jarela chat showing an agent conversation](assets/operations-chat.png)

## Document source controls

Disabling a local document source prevents newly starting single-file reindex
jobs from changing its index, including filesystem events queued before the
source was disabled. Disabling does not delete previously indexed contents.
Re-enable the source to resume indexing; delete the source to remove its
documents and chunks.

## Database performance

SQLite uses WAL mode. On upgrade, Jarela automatically creates indexes matching
message sequence pagination, dashboard date windows, thread-list ordering,
latest usage snapshots, memory lists, background retention, and signal cleanup
(see [ADR-0103](adr/0103-responsive-transcript-query-indexes.md)). An existing
large database may take longer on its first startup while those indexes build.
No manual migration, database relocation, or durability-setting changes are
needed.

Lease recovery also has dedicated deadline indexes. The embedding queue finds
its next wakeup using indexed minima instead of scanning every pending or
processing job. Existing agent uniqueness and checkpoint primary-key indexes
are reused rather than duplicated. Leading-wildcard memory searches still
require checking candidate values; ordinary indexes do not accelerate substring
matching itself.

For a repeatable synthetic comparison, run
`node scripts/benchmark-database-reads.mjs`. It uses only an in-memory database,
checks that results are unchanged, and reports median timings and query plans
before and after the indexes. These timings are not a live-workload guarantee.