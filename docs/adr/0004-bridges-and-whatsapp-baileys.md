# 4. Bridges concept and WhatsApp integration via Baileys

Date: 2026-05-17

## Status

Accepted

## Context

LangGUI agents are reached today only through the in-app chat (PWA, browser
session, or local API client). Users want to talk to their agents from
outside the app — concretely, from WhatsApp on their phone, so that a friend
or family group can DM "Agent A" and get a reply on the same channel they
already use for messaging.

Two earlier ADRs constrain the design:

- ADR-0002 picks LangGraph as the agent runtime; every entry into the agent
  goes through `prepareThreadRun`.
- ADR-0003 commits to SQLite local persistence at `~/.langgui`.

The repo invariant (`CLAUDE.md`) is **single Next.js process** and **no
required cloud calls** beyond the LLM/MCP/GitHub providers the user
configures. Adding an inbound channel breaks the second guarantee whenever
a bridge is enabled (network connectivity becomes required), and risks
breaking the first if we shell out to a sidecar process.

We considered three categories of WhatsApp integration:

1. **Meta Cloud API / Twilio WhatsApp** — official, REST + webhook. Requires
   a verified business account, a public webhook URL (so the user must run
   a tunnel like Tailscale Funnel or ngrok), and either a paid Twilio plan
   or Meta's free 1k/day tier with business verification. Heavy onboarding
   for a personal-automation use case.
2. **Puppeteer-based libraries** (whatsapp-web.js, venom-bot, open-wa) —
   wrap WhatsApp Web in a headless Chromium. Heavy memory footprint, brittle
   when WhatsApp ships UI changes, and effectively shelled out (Chromium
   side-process).
3. **Baileys** (`@whiskeysockets/baileys`) — pure-Node WebSocket client
   speaking WhatsApp's Multi-Device protocol directly. No Chromium, no
   public URL needed (it's outbound WS), pairs via QR code or pairing code,
   actively maintained, and the de-facto standard for this use case.

## Decision

Introduce a generic **Bridge** concept: a typed binding between an external
communication account and one or more agents. v1 ships a single
implementation, `kind='whatsapp'`, backed by Baileys running **in-process**
inside the same Next.js Node server.

Routing is explicit: a `bridge_routes` table maps a `(bridge_id, remote_jid)`
pair to exactly one `agent_id`. Unconfigured chats are silently dropped
(logged, no thread created, no reply sent). Each agent can be the target of
at most one route across all bridges (`UNIQUE(agent_id)` constraint) so the
existing one-thread-per-agent invariant is preserved without chat-
interleaving inside a single thread. To handle multiple WhatsApp contacts
or groups, the user creates multiple agents.

v1 is reply-only. There is no `send_channel_message` tool, no scheduled-
task push to a contact. Outbound is exclusively the agent's reply to an
inbound message routed through the bridge.

Baileys credentials (multi-device auth state) live under
`${LANGGUI_DB_DIR}/baileys/<bridge_id>/`, managed by Baileys'
`useMultiFileAuthState` helper. They never enter the SQLite DB.

## Consequences

**Positive**

- New `BridgeAdapter` interface in `lib/bridges/types.ts` accepts future
  Telegram / Slack / Discord / SMS adapters without further schema changes.
- No public tunnel required for the WhatsApp adapter — Baileys is an
  outbound WS connection, so the user can run LangGUI behind NAT.
- Reuses `prepareThreadRun` and the scheduler's drain pattern verbatim; no
  changes to the LangGraph runtime, no new entry-point to maintain.
- Personal WhatsApp accounts work directly — no business verification, no
  per-message billing.

**Negative**

- **Online requirement when any bridge is enabled.** This is a deliberate
  carve-out from the previously-stated "no required cloud calls" invariant.
  Bridges are opt-in (`enabled=0` by default on create) and the rest of
  LangGUI continues to work offline when no bridge is enabled.
- **In-process long-lived WS connections.** The Next.js Node process now
  holds one always-on WebSocket per enabled bridge (similar to the existing
  scheduler timer). Memory + connection-reconnect logic live alongside
  the request-serving code; an unhandled adapter crash could take the
  process down. Mitigated by a top-level `try/catch` in the dispatcher and
  by Baileys' built-in reconnect-with-backoff.
- **Anti-abuse risk on personal WhatsApp accounts.** Heavy automated
  activity can trigger account bans. The UI surfaces a warning at pairing
  time; the v1 scope (inbound + auto-reply only, no proactive outbound,
  no broadcast) is conservative enough for personal automation.
- **Multi-device slot consumption.** Each enabled bridge consumes one of
  the user's four WhatsApp multi-device slots.

## Out of scope (deferred to a future ADR if pursued)

- Proactive outbound (`send_channel_message` tool, scheduled-task pushes).
- Media messages (images, audio, voice notes). v1 is text-only; non-text
  inbound is silently dropped with a log line.
- Additional channels (Telegram, Slack, Email, SMS, Discord). The adapter
  interface is ready; no adapter is shipped in v1.
- Per-route quiet hours, per-sender filtering within a group, mention-only
  replies, end-to-end audit export.
