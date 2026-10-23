# Operating Jarela

Jarela's main operational views are available from the app menu. They let you review usage, inspect tool configuration, manage scheduled work, and continue agent conversations.

## Manage agents

The Agents view lists configured agents with a short summary of each instruction set. Use **New** to start adding an agent, and review the selected agent's tools and instructions before relying on it for a workflow.

![Jarela Agents view listing configured agents](assets/operations-agents.png)

## Configure your profile

Profile settings hold the identity and context shared with agents, along with persona filters and the Essential or Full experience mode. Optional location sharing and Tailscale access controls are also managed here.

![Jarela Profile settings](assets/operations-profile.png)

## Advanced settings

Advanced settings are grouped into tabs for **Credentials**, **Models**, **Privacy & security**, **Appearance**, and **Networking**. Choose the relevant tab to review provider access, model configuration, privacy controls, visual preferences, or network exposure.

![Jarela advanced settings with credential and settings categories](assets/operations-advanced-settings.png)

## Review usage

The Dashboard summarizes token use, estimated cost, cache activity, and tool reliability over a selectable time window. It also includes daily trends and model/provider breakdowns. Cost figures are estimates based on the configured pricing data, not billing statements.

Repeated dashboard computations reuse the last result for up to five seconds
when the database, pricing snapshot, date, and selected window are unchanged.
Database writes or pricing changes invalidate that server-side result. The
existing browser response cache can retain metrics for up to 30 seconds.

![Jarela usage dashboard with token, cost, and tool reliability summaries](assets/operations-dashboard.png)

## Inspect tools

The Tools view groups the catalog, installed packages, and internal runtime controls. Use it to review what is available to agents and the current package/runtime setup.

![Jarela Tools view with package and runtime sections](assets/operations-tools.png)

## Review scheduled work

The Tasks view separates scheduled tasks from event-driven tasks so each kind of background work can be reviewed in its own section.

![Jarela Tasks view showing scheduled and event-driven tasks](assets/operations-tasks.png)

## Work in chat

Chat is the per-agent workspace for conversations and their results. Keep related follow-up work in the same thread so its existing context remains available.

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