# Architecture — LangGUI

## C4 — Container

```mermaid
C4Container
    title Containers — LangGUI
    Person(user, "Developer", "Browser / installed PWA")

    System_Boundary(b, "LangGUI (Next.js process)") {
      Container(ui, "Web UI", "React 19 + Tailwind", "Chat, agents, models, memory, integrations panels")
      Container(routes, "API Routes", "Next.js Route Handlers", "REST + WebSocket endpoints under /api")
      Container(agents, "Agent Runtime", "LangGraph + @langchain/*", "State-machine orchestration of LLM + tools")
      Container(mcp, "MCP Adapter", "@langchain/mcp-adapters", "Discovers & invokes external MCP tool servers")
      Container(sched, "Scheduler", "cron-parser", "Runs background tasks on schedule, persists in DB")
      Container(stream, "Streaming Layer", "ws + undici", "Token streaming UI ↔ providers")
      ContainerDb(db, "SQLite", "@langchain/langgraph-checkpoint-sqlite", "Checkpoints, memory, settings, schedules — at ~/.langgui")
    }

    System_Ext(anthropic, "Anthropic", "Claude")
    System_Ext(openai, "OpenAI", "GPT")
    System_Ext(google, "Google GenAI", "Gemini")
    System_Ext(cohere, "Cohere", "Embeddings")
    System_Ext(mcps, "MCP Servers", "External tool providers")
    System_Ext(github, "GitHub API", "")

    Rel(user, ui, "HTTPS")
    Rel(ui, routes, "fetch / WS")
    Rel(routes, agents, "invoke")
    Rel(agents, mcp, "tool calls")
    Rel(agents, stream, "token stream")
    Rel(routes, sched, "register / trigger")
    Rel(sched, agents, "run scheduled job")
    Rel(agents, db, "checkpoint / memory")
    Rel(stream, anthropic, "HTTPS")
    Rel(stream, openai, "HTTPS")
    Rel(stream, google, "HTTPS")
    Rel(agents, cohere, "embed")
    Rel(mcp, mcps, "stdio / SSE")
    Rel(routes, github, "HTTPS")
```

## C4 — Component (Agent Runtime)

```mermaid
flowchart LR
    A[API Route /api/agents/*] --> B[Agent Factory<br/>lib/agents]
    B --> C[Provider Adapter<br/>lib/providers]
    B --> D[Tool Registry<br/>lib/tools]
    B --> E[MCP Client<br/>lib/mcp]
    C --> F[(LLM Provider)]
    D --> G[Built-in tools]
    E --> H[(External MCP servers)]
    B --> I[Checkpoint Store<br/>lib/db]
    I --> J[(SQLite ~/.langgui)]
    B --> K[Memory Store<br/>lib/stores]
    K --> J
    B --> L[Notifications<br/>lib/notifications]
```

## Key Flow — User sends a chat turn

```mermaid
sequenceDiagram
    actor U as User
    participant UI as Web UI
    participant API as /api/chat
    participant AG as Agent Runtime
    participant DB as SQLite
    participant LLM as LLM Provider

    U->>UI: types message
    UI->>API: POST /api/chat (stream)
    API->>AG: invoke(threadId, msg)
    AG->>DB: load checkpoint
    AG->>LLM: stream completion
    LLM-->>AG: tokens
    AG-->>API: token stream
    API-->>UI: SSE/WS tokens
    UI-->>U: render
    AG->>DB: save checkpoint
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
| Persistence | survive process restart | All state in `~/.langgui/*.sqlite` |
| API key handling | never leave the host | Stored in DB or env, not synced |

## External Dependencies

| Dependency | Purpose | Failure mode |
|---|---|---|
| Anthropic / OpenAI / Google / Cohere | LLM inference | Surface provider error to UI; allow model switch |
| MCP servers | External tools | Tool call returns error; agent can recover or skip |
| GitHub API | Repo / PR integration | Feature degrades; chat unaffected |
| SQLite (local) | Persistence | Fatal — startup fails fast with clear error |

## Decisions

See [`docs/adr/`](./docs/adr/). Significant choices on persistence, agent runtime, and provider strategy will be recorded as ADRs.
