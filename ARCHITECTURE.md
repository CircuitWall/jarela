# Architecture — Jarela

## C4 — Container

```mermaid
C4Container
    title Containers — Jarela
    Person(user, "Developer", "Browser / installed PWA")
    Person_Ext(wa_user, "WhatsApp peer", "Phone number paired via Baileys")

    System_Boundary(b, "Jarela (Next.js process)") {
      Container(ui, "Web UI", "React 19 + Tailwind", "Chat, agents, models, memory, integrations panels")
      Container(guard, "Origin / CSRF Guard", "lib/auth", "Rejects cross-origin mutating requests; same-port WS upgrade gating")
      Container(routes, "API Routes", "Next.js Route Handlers", "REST + SSE endpoints under /api/v1")
      Container(agents, "Agent Runtime", "LangGraph + @langchain/*", "State-machine orchestration of LLM + tools")
      Container(mcp, "MCP Adapter", "@langchain/mcp-adapters", "Discovers & invokes external MCP tool servers")
      Container(sched, "Scheduler", "cron-parser", "Runs background tasks on schedule, persists in DB")
      Container(bridges, "Bridges", "lib/bridges", "Inbound transports (WhatsApp/Baileys) routed to agents")
      Container(stream, "Streaming Layer", "ws + undici", "WS sidecar on same port; heartbeat + stall watchdog; token streaming UI ↔ providers")
      Container(crypto, "Crypto Envelope", "lib/crypto", "AES-GCM-at-rest for sensitive memory + OAuth tokens; OS keychain or .secret-key fallback")
      ContainerDb(db, "SQLite", "@langchain/langgraph-checkpoint-sqlite + native sqlite", "Checkpoints, memory, settings, schedules, proposals, bridges — at ~/.jarela")
    }

    System_Ext(anthropic, "Anthropic", "Claude")
    System_Ext(openai, "OpenAI", "GPT")
    System_Ext(google, "Google GenAI", "Gemini")
    System_Ext(deepseek, "DeepSeek", "OpenAI-compatible")
    System_Ext(cohere, "Cohere", "Embeddings")
    System_Ext(mcps, "MCP Servers", "External tool providers (stdio / SSE)")
    System_Ext(github, "GitHub API", "Repo / PR / Copilot OAuth")
    System_Ext(whatsapp, "WhatsApp Web", "Baileys-paired endpoint")

    Rel(user, ui, "HTTPS")
    Rel(ui, guard, "fetch / WS upgrade")
    Rel(guard, routes, "allow same-origin")
    Rel(routes, agents, "invoke")
    Rel(agents, mcp, "tool calls")
    Rel(agents, stream, "token stream")
    Rel(routes, sched, "register / trigger")
    Rel(sched, agents, "run scheduled job")
    Rel(wa_user, whatsapp, "message")
    Rel(whatsapp, bridges, "stream events")
    Rel(bridges, agents, "deliver as user turn")
    Rel(agents, db, "checkpoint / memory (via crypto)")
    Rel(agents, crypto, "encrypt sensitive at rest")
    Rel(crypto, db, "store ciphertext")
    Rel(stream, anthropic, "HTTPS")
    Rel(stream, openai, "HTTPS")
    Rel(stream, google, "HTTPS")
    Rel(stream, deepseek, "HTTPS")
    Rel(agents, cohere, "embed")
    Rel(mcp, mcps, "stdio / SSE")
    Rel(routes, github, "HTTPS")
```

## C4 — Component (Agent Runtime)

```mermaid
flowchart LR
    A[API Route /api/v1/*] --> G0[Origin Guard<br/>lib/auth]
    G0 --> B[Agent Factory<br/>lib/agents]
    B --> C[Provider Adapter<br/>lib/providers]
    B --> D[Tool Registry<br/>lib/tools]
    B --> E[MCP Client<br/>lib/mcp]
    C --> F[(LLM Provider)]
    D --> G[Built-in tools]
    E --> H[(External MCP servers)]
    B --> I[Checkpoint Store<br/>lib/db]
    I --> J[(SQLite ~/.jarela)]
    B --> K[Memory Store<br/>lib/stores]
    K --> CR[Crypto Envelope<br/>lib/crypto]
    CR --> J
    K --> J
    B --> L[Notifications<br/>lib/notifications]
    BR[Bridges<br/>lib/bridges] --> B
    SC[Scheduler<br/>lib/scheduler] --> B
    WS[WS Sidecar<br/>lib/streaming] -.heartbeat + stall watchdog.-> A
```

## Key Flow — User sends a chat turn

```mermaid
sequenceDiagram
    actor U as User
    participant UI as Web UI
    participant G as Origin Guard
    participant API as /api/v1/agents/:id/stream
    participant AG as Agent Runtime
    participant DB as SQLite
    participant LLM as LLM Provider

    U->>UI: types message
    UI->>G: POST + WS upgrade
    G->>G: check Origin / Sec-Fetch-Site
    G->>API: forward if same-origin
    API->>AG: invoke(threadId, msg)
    AG->>DB: load checkpoint
    AG->>LLM: stream completion
    LLM-->>AG: tokens
    AG-->>API: token stream
    API-->>UI: SSE / WS tokens
    UI-->>U: render
    AG->>DB: save checkpoint
```

## Key Flow — Inbound bridge message (WhatsApp)

```mermaid
sequenceDiagram
    actor P as WhatsApp peer
    participant WA as WhatsApp Web
    participant BR as Bridges (Baileys)
    participant DSP as bridges/dispatcher
    participant AG as Agent Runtime
    participant DB as SQLite
    participant N as Notifications

    P->>WA: send message
    WA-->>BR: stream event
    BR->>DSP: normalize → InboundMessage
    DSP->>DB: route JID → agent_id + thread_id
    DSP->>AG: deliver as user turn
    AG->>DB: append + run graph
    AG-->>DSP: reply text
    DSP->>BR: send outbound
    BR-->>WA: deliver to peer
    AG->>N: SSE push to any open UI
```

## Key Flow — Scheduled background task

```mermaid
sequenceDiagram
    participant S as Scheduler
    participant AG as Agent Runtime
    participant DB as SQLite
    participant N as Notifications

    S->>DB: poll due jobs (cron)
    S->>AG: run(jobId)
    AG->>DB: load state
    AG->>AG: execute graph
    AG->>DB: persist result
    AG->>N: notify (if configured)
```

## Non-Functional Requirements

| NFR | Target | Notes |
|---|---|---|
| Cold start (dev) | < 5 s | `npm run dev` |
| First token latency | < 1.5 s p95 | Network-bound on provider |
| Local-only operation | required | No telemetry, no required cloud backend |
| Persistence | survive process restart | All state in `~/.jarela/*.sqlite` |
| API key handling | never leave the host | Stored in DB or env, not synced |
| Same-origin enforcement | required | CSRF / DNS-rebinding guard in `lib/auth/access.ts` |
| Secrets at rest | required for sensitive namespaces | AES-GCM envelope, master key in OS keychain or `.secret-key` fallback |
| WS resilience | reconnect within seconds of network change | Heartbeat + stall watchdog in `lib/streaming/` |
| CI on every push | required | `.github/workflows/ci.yml`: lint + tsc + build + live integration suite |

## External Dependencies

| Dependency | Purpose | Failure mode |
|---|---|---|
| Anthropic / OpenAI / Google / Cohere | LLM inference | Surface provider error to UI; allow model switch |
| MCP servers | External tools | Tool call returns error; agent can recover or skip |
| GitHub API | Repo / PR integration | Feature degrades; chat unaffected |
| SQLite (local) | Persistence | Fatal — startup fails fast with clear error |

## Decisions

See [`docs/adr/`](./docs/adr/). Significant choices on persistence, agent runtime, and provider strategy will be recorded as ADRs.
