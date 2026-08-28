---
status: "proposed"
date: 2026-08-27
deciders: Andrew
consulted:
informed:
---

# Context preparation: media interpretation layer and system-prompt caching

> **Note:** This document is written as an RFC. Once accepted, it becomes the
> ADR for this decision. Status flips to `accepted` at merge of the
> implementation PR (or a dedicated acceptance PR if implementation is
> split).

## Context and Problem Statement

This RFC bundles two closely related sources of per-turn TTFB on the main
assistant. Both stem from the same underlying issue: **Jarela rebuilds
things on every turn that do not actually change on every turn.** Media
re-perception is the payload-side symptom; system-prompt reassembly is
the prefix-side symptom. They share the same fix shape (content-addressed
cache + explicit invalidation) and are therefore designed together.

### Part A — Media

Jarela already stores images as disk refs rather than inline base64
(ADR-0065) and shrinks them at ingest (ADR-0066). That fixes storage bloat
and warm-summary payload size, but three problems remain:

1. **Non-image binary attachments (PDFs, audio, video, arbitrary files from
   bridges) are still stored inline as base64** in `messages` rows. Voice
   notes and documents forwarded through the WhatsApp bridge are now the
   dominant driver of large message rows.
2. **Every image in the hot window is re-materialized as raw bytes on every
   turn** and re-sent to the provider. Providers re-run vision perception
   each time, at both a latency and a token/cost hit, even for turns that
   have nothing to do with the image.
3. **Attachments have no persistent textual interpretation** (caption / OCR
   / transcript). Warm summaries collapse them to `[image attachment:
   image/png]`, facts recall cannot find them by content, and the model
   cannot "remember" what an old image contained without re-perceiving it.

The user-visible symptom is high TTFB on agents with attachment-heavy hot
context (primarily the main assistant) and, on a slower time scale, an
inability to semantically recall past attachments.

### Part B — System prompt and skills

On every turn `streamWithConfigImpl` reassembles the full system prompt
from scratch:

- Harness sections (capabilities / plan-first / presentation / citation /
  self-config) fetched and concatenated.
- All enabled skills for the agent read from disk (`SKILL.md` files) and
  spliced in as an "Available skills" catalogue.
- Persona directives resolved (adaptive persona, integrations block,
  documents block, memory block, harness metadata).
- Tool schemas serialized for the provider payload.

None of these change between most consecutive turns. Yet:

1. **Disk reads for every skill on every turn**, even when the skill set
   is identical to the previous turn.
2. **Harness body concatenation and section-flag evaluation** run every
   turn against config that changes at most a few times per session.
3. **The provider-side prompt-cache prefix is unstable**: any variability
   in ordering, whitespace, or transient content (e.g. a rotating
   `Current time:` line placed inside the cached region) invalidates the
   provider's prompt cache and forces re-tokenisation of the full
   prefix. Anthropic in particular charges full input tokens on a cache
   miss.

The user-visible symptom is a TTFB floor that persists even on threads
with no attachments and a warm summary cache hit — the prompt reassembly
and tokenisation are simply not free.

The user's stated constraints (2026-08-27):

- Improve caching on system prompts including skills.
- Add sensible **cache invalidation triggered by config change** (agent
  config edit, skill file change, harness change, integration change).
- Add a **second layer to preserve LLM-side prompt caching** — i.e.
  ensure the cached region we send is byte-stable so provider prompt
  caches actually hit.

The trigger for this RFC is a design conversation on 2026-08-27. User
directives:

- Media should be **kept as a local file reference plus a text interpretation**
  in the message row.
- **Hot context should not re-perceive attachments every turn.** The model
  should only re-examine an attachment when the current turn explicitly
  needs it.
- Improve **system prompt caching** including skills, with config-change
  invalidation and a second layer that preserves **LLM-side prompt
  caching**.
- The current setup is reliable and should not regress.

## Decision Drivers

* **TTFB on attachment-heavy threads.** Every turn that ships raw image
  bytes to the provider pays perception cost the user didn't ask for.
* **Semantic recall of past attachments.** `documents_search`, facts tier,
  and warm summaries all operate on text. Without a text form, attachments
  are invisible to them.
* **Reliability and back-compat.** Existing threads with inline base64 or
  bridge-store files must keep working. Rollout must be behind a flag.
* **Provider portability.** Anthropic, OpenAI, Gemini, and Cohere all
  handle vision differently. The materialization decision must be per-turn
  and per-provider, not baked into storage.
* **Local-first, no forced cloud calls** (per CLAUDE.md convention). The
  captioner must be pluggable and optional; users who don't want it get
  a `[file]` placeholder instead of a description.
* **Prompt stability across turns.** Provider prompt caches (Anthropic
  `cache_control`, OpenAI/Gemini implicit prefix caching) only pay off if
  the cached region is byte-stable. Anything that varies per turn must
  be pushed *below* the cache boundary.

## Considered Options

### Option A — Do nothing

Rely on the existing hot/warm/facts tiering and ADR-0065 to keep costs
bounded.

### Option B — Extend refs to all binaries, no interpretation layer

Mirror `image_ref` to a generic `file_ref` for PDFs / audio / video / bridge
attachments. Content-addressed store. Warm summary sees `[file:
<name>.pdf, application/pdf]`. Hot context still re-materializes.

### Option C — Refs + interpretation layer + materialization policy *(recommended)*

Do Option B, and additionally:

1. On spill, kick off a background **interpreter** that produces a text
   description (caption for images, OCR text for scanned docs, transcript
   for audio, extracted text for PDFs) and stores it keyed by content hash.
2. Introduce a per-turn **materialization policy** for hot context. For
   each ref in the hot window, decide whether to emit `pixels/bytes`,
   `text-only`, or `skip`, based on recency and whether the current turn
   references the attachment.
3. Warm summary and facts recall consume the stored text automatically.
4. Provide a model-side re-hydration escape hatch (v2): the model can emit
   a sentinel requesting bytes for a specific `sha256`; the agent loop
   re-runs the turn with that ref promoted to `pixels`.

### Option D — Move all media handling into a separate Go/Rust daemon

Extract attachment ingest, interpretation, and materialization into a
sidecar process. Cleaner isolation, but violates the current invariant
(single Next.js process, per CLAUDE.md § Decision triggers) and is
disproportionate to the problem size.

## Decision Outcome

Chosen option for **media**: **Option C** (refs + interpretation +
materialization policy). It is the only option that addresses all three
media problems with a single primitive (content-hash-keyed text
interpretation) and stays within the single-process invariant. Option A
ignores a real cost driver; Option B leaves the re-perception cost —
which, post-ADR-0065, is now the larger contributor to TTFB; Option D is
over-engineering for a problem that fits comfortably inside the existing
process.

Chosen approach for **system prompt caching**: a two-layer cache with
explicit invalidation (see Design §6). Layer 1 is a Jarela-side in-process
cache of the assembled prompt prefix keyed on a composite version hash;
layer 2 is a byte-stable ordering that preserves provider-side prompt
caching. Both must be present — layer 1 alone still causes provider
cache misses; layer 2 alone still burns CPU on reassembly.

### Consequences

* Good, because hot context stops sending stale image bytes to the
  provider on unrelated turns.
* Good, because warm summaries and facts recall become "aware" of
  attachment content by name and description.
* Good, because non-image attachments finally stop bloating message rows.
* Good, because the primitive (interpretation keyed by `sha256`) is
  reusable for `documents_search`-style indexing of ingested media.
* Bad, because there is now a background job that can fail, retry, or
  produce low-quality output. Failure mode must degrade gracefully to
  `[file: <name>]`.
* Bad, because there is one more per-turn decision (`chooseMaterialization`)
  in the hot path. Must stay pure and fast (<1 ms).
* Bad, because the interpreter costs LLM/OCR calls the user did not
  explicitly request. Must be off-by-default until the user opts in.
* Good, because per-turn prompt reassembly cost drops to near-zero on
  cache hit (typical case: same agent, same skills, same harness).
* Good, because provider-side prompt-cache hit rates improve (Anthropic
  can be measured directly via `cache_read_input_tokens` in the response
  usage block).
* Bad, because the invalidation surface is now explicit — any code path
  that mutates agent config / skills / harness / integrations must call
  the invalidator. Miss it and stale prompts persist until process
  restart.

---

## Design

### 1. Storage: extend the ref pattern to all binaries

Today, `spillImageAttachments` in `lib/attachments/spill.ts` replaces
inline `image` parts with `image_ref`. Extend the same pattern:

- Add a `file_ref` content-part variant to the message schema:
  ```ts
  type FileRef = {
    type: "file_ref";
    media_type: string;      // MIME
    name: string;            // original filename
    sha256: string;          // content hash
    size: number;            // bytes
    // Optional media-specific hints:
    duration_ms?: number;    // audio/video
    page_count?: number;     // pdf
  };
  ```
- Add `spillFileAttachments` alongside `spillImageAttachments`, called from
  `prepareThreadRun`. Same content-addressed store
  (`<dataDir>/files/<sha256>.<ext>`).
- Unify the bridge attachment store
  (`lib/bridges/attachment-store.ts`) onto the same content-addressed
  store. Bridge layer becomes a producer of refs, not a parallel
  filesystem hierarchy. Migration: on read of a legacy
  `bridge-attachments/…` path, opportunistically move+rehash into the
  unified store and update the message row.
- Add `spillLegacyFileAttachments` to `db/migrations.ts`, mirroring
  `spillLegacyImageAttachments`. Idempotent, one-shot sweep.

### 2. Interpretation layer

New table:

```sql
CREATE TABLE IF NOT EXISTS attachment_interpretations (
  sha256          TEXT PRIMARY KEY,
  media_type      TEXT NOT NULL,
  kind            TEXT NOT NULL,           -- 'caption' | 'ocr' | 'transcript' | 'text_extract'
  interpretation  TEXT NOT NULL,           -- the actual text
  interpreter     TEXT NOT NULL,           -- e.g. 'gemini-1.5-flash', 'tesseract', 'whisper.cpp'
  interpreter_version TEXT,
  language        TEXT,                    -- BCP-47 if known
  quality         REAL,                    -- 0..1 optional confidence
  created_at      INTEGER NOT NULL,
  bytes_processed INTEGER,
  cost_cents      INTEGER                  -- optional accounting
);
CREATE INDEX IF NOT EXISTS idx_attachment_interpretations_media
  ON attachment_interpretations(media_type);
```

Keyed by `sha256` so it survives message deletion and dedups across
threads/agents.

**Interpreter registry.** A pluggable module in `lib/attachments/interpret/`:

```ts
interface AttachmentInterpreter {
  name: string;
  accepts(mediaType: string): boolean;
  interpret(input: {
    path: string;
    sha256: string;
    media_type: string;
    hints?: Record<string, unknown>;
  }): Promise<{
    kind: "caption" | "ocr" | "transcript" | "text_extract";
    text: string;
    language?: string;
    quality?: number;
    bytes_processed?: number;
    cost_cents?: number;
  }>;
}
```

Built-in interpreters, in priority order:

- **Text-first** for `text/*`, `application/json`, source code MIME types:
  read directly, no LLM.
- **PDF text extract** for `application/pdf`: `pdf-parse` or equivalent.
  Fall back to OCR if extracted text is empty.
- **Image caption + OCR** for `image/*`: a small vision model via the
  existing provider adapters. Default: Gemini Flash if configured, else
  the user's cheapest configured vision-capable provider. Off if none
  configured.
- **Audio transcript** for `audio/*`: initially deferred (returns
  `[audio/<subtype>, <duration>s, no transcript configured]`). Local
  `whisper.cpp` can be plugged in later.
- **Fallback** for everything else: `[file: <name>, <media_type>,
  <size>]`.

The interpreter runs **asynchronously** after spill, off the hot path.
The message row is written with a `null` interpretation and updated when
the job completes. If the LLM invocation happens before interpretation is
ready, the materialization policy falls back to `bytes` for images (safe
default) and `[file: …]` placeholder for others.

**Failure model.** Interpreter failures are logged and stored as a
sentinel row with `interpretation = ''` and `quality = 0`. A background
retry runs at most once, after 24h. No infinite retry loops.

**Feature flag.** Off by default. Enabled via
`JARELA_ATTACHMENT_INTERPRETER=1` (env schema entry) and/or a per-agent
toggle stored in agent config. Rationale: it costs external calls the
user did not request; opt-in respects the CLAUDE.md "no required cloud
calls" convention.

### 3. Materialization policy

New function called from `toBaseMessages` (or the provider adapter's
message serialization path — TBD in implementation, see Open Questions):

```ts
type MaterializationMode = "bytes" | "text" | "skip";

interface MaterializationContext {
  msgIndex: number;           // index within the hot window (0 = oldest)
  hotWindowSize: number;
  userTurn: string;           // this turn's user message, lowercased
  toolCallsThisTurn: string[];// tool names invoked in the trailing assistant turn
  interpretation: string | null;
  ref: ImageRef | FileRef;
  provider: string;           // 'anthropic' | 'openai' | 'gemini' | ...
}

function chooseMaterialization(ctx: MaterializationContext): MaterializationMode;
```

Default policy (v1):

1. **Recency rule.** If the ref is in the last `N` messages of the hot
   window (default `N=2`, configurable), return `bytes`.
2. **Explicit reference rule.** If `userTurn` contains any of:
   - the ref's `name` (case-insensitive substring),
   - any of a small keyword set (`"image"`, `"photo"`, `"picture"`,
     `"attachment"`, `"file"`, `"screenshot"`, `"receipt"`, `"pdf"`,
     `"document"`),
   - a phrase like "look again", "re-examine", "zoom in", "what does",
   - a token that appears in the stored `interpretation` (naive: split
     interpretation into words ≥5 chars, check overlap),

   return `bytes`.
3. **Tool-followup rule.** If the ref was produced by a tool call in the
   immediately preceding assistant turn (`toolCallsThisTurn` non-empty
   and the ref appears in the tool result), return `bytes`.
4. **Interpretation available.** If `interpretation` is non-null and
   non-empty, return `text`.
5. **Fallback.** If none of the above match and no interpretation exists,
   return `bytes` for images (safe default preserves current behavior)
   and `text` (as `[file: <name>]`) for `file_ref`.

Per-provider override: some providers cost or perform noticeably worse
with mixed content. Providers may opt into a more aggressive default via
a registered `materializationDefaults` field on the adapter.

The policy is pure and stateless; it takes only the ref, the hot-window
metadata, and the current turn. No DB reads inside the loop (the
interpretation is prefetched in a single query by `sha256` before the loop
runs).

### 4. Emission

When mode is `bytes`: current behavior. Read the file, base64-encode,
attach as provider-native image/file block.

When mode is `text`: emit a single text part in place of the media block:

```
[image: <interpretation> — {name}, {media_type}, {WxH}]
[file: <interpretation-first-line-or-name> — {name}, {media_type}, {size}]
```

The exact wrapper text is per-provider (some providers render markdown
literally in tool contexts).

When mode is `skip`: omit the ref entirely from the provider payload but
retain it in the SQLite row.

### 5. Warm-summary and facts consumption

Attachment interpretations become first-class text inputs for the existing
context tiers. The warm-summary builder should include interpretation text
when summarising messages with media refs, so old image/file/audio turns are
compressed by what they contained rather than by a generic placeholder.

The facts tier should likewise index and recall interpretation text keyed to
the originating message and attachment hash. A recalled hit should identify
the attachment by name, media type, and source message so the agent can cite
or ask to re-examine the original bytes when precision matters.

Consumption is gated by the same interpreter feature flag and quality
threshold. When an interpretation is missing, failed, or below threshold, the
current placeholder behaviour remains the fallback; no existing media path is
made worse by opting out.

### 6. System-prompt cache — layer 1 (Jarela-side)

A per-process LRU cache keyed on a composite version hash of everything
that contributes to the assembled prompt prefix:

```
prefixKey = sha256([
  agentId,
  agentConfigVersion,      // bumped on any agent config write
  harnessId,
  harnessVersion,          // bumped on harness edit
  skillsFingerprint,       // sha256 of sorted (skill_id, mtime, size) tuples
  toolPolicyVersion,       // bumped on tool allowlist change
  integrationsFingerprint, // sha256 of enabled integration ids + creds hash (non-secret)
  personaPresetId,         // adaptive persona preset only; NOT the per-turn signal
  harnessBodyHash,         // fallback catch-all for section body edits
].join("\0"))
```

On hit, the cache returns the pre-assembled prompt string plus a
precomputed `skillsCatalogue` fragment.

**Invalidation triggers** (explicit, not TTL-based):

- Any write via `update_agent_instruction`, `propose_config_change`
  (kind `update_agent`, `update_agent_tools`, `upsert_harness`),
  integration enable/disable, or provider key change increments the
  relevant version and evicts the key.
- Skill file changes (SKILL.md write/delete via `write_skill`, or
  filesystem mtime change picked up by the existing skills watcher)
  invalidate `skillsFingerprint`.
- Process restart: cache starts cold.

**What is NOT in the cached prefix** (must be appended below the cache
boundary to protect layer 2):

- `Current time:` line — moves to the tail of the system prompt.
- Adaptive persona signal (`neutral` vs. `frustrated` etc.) — appended
  after the cache boundary.
- Per-turn memory recall ("Relevant context" bullets) — appended after.
- Per-turn documents recall summary — appended after.
- User-turn-specific integration reminders (rare).

All of these are inherently per-turn and would poison the cache.

Cache size: default 32 entries per process (tunable), evicts LRU. At ~50
KB per assembled prefix that is <2 MB resident, negligible.

### 7. System-prompt cache — layer 2 (provider-side)

The cache from §6 also determines the **`cache_control` breakpoint** we
send to providers that support explicit prompt caching (Anthropic today;
others as they add support):

- The assembled cached prefix (harness + skills catalogue + tools schema
  block + persona preset + integrations block) is emitted as a single
  contiguous text region and marked with a `cache_control: { type:
  "ephemeral" }` breakpoint at its end (Anthropic-specific block
  attribute; other providers ignore unknown fields).
- Everything after the breakpoint is the per-turn tail: time, persona
  signal, memory recall, documents recall, warm summary, hot window
  messages, and finally the user turn.
- Ordering inside the cached region is **fixed and deterministic**
  (alphabetical or a documented canonical order). Any nondeterministic
  serialization (Set/Map iteration, `Date.now()` interpolations, random
  IDs) is a bug.

This gives us two independent wins per turn:

- **Layer 1 hit** → skip reassembly (~5-20 ms saved per turn depending
  on skill count).
- **Layer 2 hit** → provider bills cached tokens at ~10% of normal input
  cost (Anthropic) and returns the first token faster.

On config change: layer 1 evicts, layer 2 rebuilds. First turn after a
config change is a double miss (expected). Subsequent turns hit both
again.

**Verification.** Every provider adapter that supports prompt caching
must log `cache_read_input_tokens` / equivalent in the perf breadcrumb
row. If the ratio to `input_tokens` is <50% on a warmed thread, we have
a cache-poisoning bug and must trace which per-turn field leaked into
the cached region.

### 8. Skills catalogue precomputation

Currently the "Available skills" block is assembled per turn by iterating
the agent's enabled skills and reading each `SKILL.md` frontmatter. This
is moved to a memoised builder keyed on `skillsFingerprint`:

- On skill read/write, a small in-memory index tracks `(skill_id → { id,
  name, description, mtime, size })`.
- The catalogue string is rebuilt only when the fingerprint changes.
- Skill *bodies* are still lazy-loaded via `read_skill` on demand; only
  the catalogue lives in the prefix. This preserves the current design
  (skills are opt-in per turn) while removing the per-turn disk scan.

### 9. Model-driven re-hydration (v2, out of scope for the first PR)

If the model, on receiving a `text` materialization, decides it needs the
pixels, it can emit a sentinel tool call:

```
rehydrate_attachment({ sha256: "…", reason: "…" })
```

The agent loop catches this, promotes that ref to `bytes` for the next
step, and continues. Deferred to a follow-up ADR because it requires
provider-agnostic tool-call plumbing and a stable sentinel format.
Not required for the v1 win.

---

## Rollout plan

Phased, each phase independently mergeable and reversible:

1. **RFC merge (this PR)** — no code change. Signals design intent.
2. **`file_ref` storage + legacy migration** — code + schema, no behavior
   change for images. Removes the base64-inline path for non-image media.
3. **Attachment interpretation table + text-first + PDF text extract**
   interpreters. Feature-flagged. No consumption yet.
4. **Warm summary + facts recall consume interpretation.** Free win for
   users who enabled the flag in step 3.
5. **Materialization policy in hot context.** Behind a per-agent flag,
   default off. Enable on the main assistant first, measure, then expand
   default.
6. **Skills catalogue memoisation** (§8). Pure refactor, no behavior
   change. Independently mergeable.
7. **Layer-1 prompt cache** (§6) with explicit invalidation hooks. Adds
   invalidator calls to every config-write path. Feature-flagged
   (`JARELA_PROMPT_CACHE=1`, default on after one release cycle).
8. **Layer-2 provider cache_control emission** (§7). Anthropic first;
   log `cache_read_input_tokens` in perf breadcrumbs to verify.
9. **Image caption interpreter** (adds cost — separate opt-in).
10. **Attachment inventory panel** in UI (nice-to-have).
11. **Model-driven re-hydration** (v2 ADR).

Rollback for each phase: flip the flag, or revert the specific
interpreter/consumer wiring. Storage of refs and interpretations is
strictly additive — no destructive schema migration.

## Impact on public API

None of the surfaces listed in `package.json#exports` (per ADR-0061 /
CONTRIBUTING § Public API) change signature. Internal changes only.

## Metrics for success

Before / after on the main assistant, measured via new `perf` breadcrumbs
(one row per turn: `history_ms`, `prompt_assemble_ms`, `prompt_cache_hit`,
`provider_ttfb_ms`, `input_tokens`, `cache_read_input_tokens`, `total_ms`):

**Media:**
- **TTFB per turn** on threads with ≥3 attachments in hot window.
  Target: -30% median once phase 5 is enabled with a warm interpretation
  cache.
- **Provider image-token count per turn.** Target: measurable reduction,
  no regression in text tokens.
- **Facts recall precision.** Target: `documents_search`-style queries
  that reference past image content start returning the source message.

**Prompt caching:**
- **`prompt_assemble_ms`** on cache hit. Target: <1 ms (from current
  ~5-20 ms).
- **`cache_read_input_tokens / input_tokens`** on the second turn after
  a config-stable window opens (Anthropic). Target: >70% within one
  turn, >90% within three turns.
- **Cache-hit rate for layer 1** across a session. Target: >95% on
  sessions with no config changes.
- **Invalidation correctness.** Target: zero observed stale-prompt bugs
  after config edit (verified by an integration test that edits agent
  instructions and asserts the next turn uses the new text).

## Risks

- **Provider disagreement.** Gemini in particular is picky about mixed
  content blocks in a single message. Mitigation: per-provider policy
  override; keep `bytes` as the default when unsure.
- **Cache-invalidation miss.** A config path that mutates behavior but
  forgets to bump its version leaves stale prompts in layer 1 until
  restart. Mitigation: centralise all agent-config writes through a
  single helper that bumps `agentConfigVersion` unconditionally; add a
  lint rule / test that flags direct DB writes to the config table.
- **Cache poisoning by hidden per-turn field.** Any per-turn value that
  sneaks into the cached region silently kills the layer-2 hit rate.
  Mitigation: the perf breadcrumb assertion (`cache_read` ratio) is a
  regression alarm; investigate any drop.
- **Cross-provider serialization drift.** Anthropic accepts `cache_control`
  on text blocks; others must ignore the field cleanly. Mitigation: emit
  it only through the Anthropic adapter's serializer; other adapters
  strip it at the boundary.
- **Poor interpretation quality damages recall.** A wrong caption in facts
  is worse than no caption. Mitigation: store `quality` score, gate
  consumption behind a threshold.
- **User surprise: "why can't you see the image anymore?"** Mitigation:
  keep phase-5 flag default off; add a clear UI hint on assistant bubbles
  where the attachment was degraded to text, with a "re-examine" action
  that forces `bytes` on the next turn.
- **OneDrive-synced repo caveat (CLAUDE.md § Known constraints):** the
  `<dataDir>/files/` store lives under `~/.jarela`, not the repo, so
  OneDrive sync of the repo is unaffected. Users who put `~/.jarela` on
  OneDrive (rare) will sync their attachment blobs; called out in docs.

## Open Questions

1. **Where does the policy live?** `toBaseMessages` (central, provider-
   agnostic) or per-provider adapter (flexible, more code)? Leaning
   central with a per-provider defaults hook.
2. **Interpreter concurrency.** Fire-and-forget vs. lightly rate-limited
   queue. Recommend a simple in-process queue with a small concurrency
   cap to avoid hammering a vision provider during a bulk import.
3. **Cost visibility.** Should interpreter cost be surfaced in the UI
   next to LLM cost? Probably yes, but out of scope here.
4. **Existing legacy image `[image attachment: image/png]` warm-summary
   strings.** Do we backfill them with interpretation, or leave the
   summaries alone and let the next natural warm-boundary shift regenerate
   them? Recommend the latter — no backfill.
5. **Skill body caching.** Should `read_skill(id)` bodies also be cached
   (they're read on demand within a turn)? Recommend a small LRU keyed
   on `(skill_id, mtime)`. Small win, trivial to add.
6. **Layer-1 cache scope.** Per-process (simple, resets on restart) or
   persisted to SQLite (survives restart, adds complexity)? Recommend
   per-process for v1; prompts are cheap to reassemble on cold start.
7. **Adaptive persona and cache boundary.** The adaptive persona block
   currently varies per turn (empathy/expressiveness numbers). Options:
   (a) coarsen to the preset id only inside the cached region and put
   the fine-grained numbers below the boundary; (b) drop from the cached
   region entirely and re-emit below. Recommend (a): preset id is
   stable, numbers are per-turn.

## More Information

- ADR-0065 — Image attachments as disk refs
- ADR-0066 — Shrink image attachments at ingest
- ADR-0039 — `prepareThreadRun` decomposition (spill lives here)
- ADR-0044 — Per-channel warm summary and attributed context
- ADR-0024 — Document RAG (interpretation table is adjacent to this)
- `lib/attachments/spill.ts` — current image spill implementation
- `lib/bridges/attachment-store.ts` — parallel bridge attachment store
  (to be unified)
- `lib/agents/llm.ts` — `streamWithConfigImpl`, target for prompt-cache
  integration
- `lib/agents/prepare/` — prompt assembly modules (harness, skills,
  persona, integrations)
- Anthropic prompt caching docs — https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
