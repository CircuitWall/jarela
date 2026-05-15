# LangGUI

A local-first, browser-based GUI for orchestrating multi-provider LLM agents — built on Next.js + LangGraph with SQLite persistence, MCP tool support, scheduled tasks, and PWA install.

## Why

A single, install-anywhere desktop-grade UI to drive Claude / OpenAI / Gemini / Cohere agents with persistent memory, scheduled background tasks, and pluggable tools (MCP) — without depending on a hosted backend.

## Architecture (C4 Context)

```mermaid
C4Context
    title System Context — LangGUI
    Person(user, "Developer", "Drives agents from the browser/PWA")
    System(langgui, "LangGUI", "Next.js app: UI + API + agent runtime")
    System_Ext(anthropic, "Anthropic API", "Claude models")
    System_Ext(openai, "OpenAI API", "GPT models")
    System_Ext(google, "Google GenAI", "Gemini models")
    System_Ext(cohere, "Cohere API", "Embeddings / models")
    System_Ext(mcp, "MCP Servers", "Tool providers via @langchain/mcp-adapters")
    System_Ext(github, "GitHub API", "Repo / PR integrations")
    SystemDb_Ext(sqlite, "SQLite (~/.langgui)", "LangGraph checkpoints, memory, settings")

    Rel(user, langgui, "HTTPS / WebSocket")
    Rel(langgui, anthropic, "HTTPS")
    Rel(langgui, openai, "HTTPS")
    Rel(langgui, google, "HTTPS")
    Rel(langgui, cohere, "HTTPS")
    Rel(langgui, mcp, "stdio / SSE")
    Rel(langgui, github, "HTTPS")
    Rel(langgui, sqlite, "reads/writes")
```

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for container & component views and key flows.

## Run

```bash
# install
npm install

# configure (optional — keys can also be set in the Models panel UI)
cp .env.example .env.local

# dev
npm run dev          # http://localhost:3000

# prod
npm run build && npm start
```

## Test

```bash
npm run test:live        # live integration smoke tests
npm run test:live:full   # extended live test suite
npm run lint
```

## Deploy

Currently runs locally. PWA-installable via `next-pwa`. No CI/CD wired yet — deployment story is an open ADR.

## Owner

- **Maintainer:** Andrew Wu (`redacted@example.com`)
- **On-call / Slack:** N/A (personal project)

## Decisions

Architecture decisions live in [`docs/adr/`](./docs/adr/). See [ADR-0001](./docs/adr/0001-record-architecture-decisions.md).
