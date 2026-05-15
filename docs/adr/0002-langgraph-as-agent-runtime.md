---
status: accepted
date: 2026-05-15
deciders: Andrew Wu
---

# Use LangGraph as the agent orchestration runtime

## Context and Problem Statement

LangGUI needs an agent runtime that supports tool-calling, streaming, multi-step reasoning, persistence (so background tasks and long chats survive restarts), and works with multiple LLM providers behind a single abstraction.

## Decision Drivers

* Local-first — runtime must run inside the Next.js process, no extra services.
* Persistence — checkpoint/restore for long-running and scheduled tasks.
* Multi-provider — Claude, GPT, Gemini, Cohere from one orchestration layer.
* Tool calling — native MCP tool integration.
* Boring/explicit state machine, not a black-box agent.

## Considered Options

* LangGraph (`@langchain/langgraph` + `@langchain/langgraph-checkpoint-sqlite`)
* Vercel AI SDK + custom orchestration
* Roll-your-own state machine over provider SDKs

## Decision Outcome

Chosen option: **LangGraph**, because it ships an explicit state-machine model, has a SQLite checkpointer that maps directly to our `~/.langgui` persistence model, and integrates with `@langchain/mcp-adapters` for MCP tooling without extra glue.

### Consequences

* Good — checkpointing is a one-line concern; scheduler can resume jobs trivially.
* Good — provider abstraction via `@langchain/*` packages.
* Bad — adds the LangChain dependency surface; pinning and upgrades require care.
* Bad — debugging agent loops is non-trivial.

## More Information

* See `lib/agents/` for runtime entry points.
* Checkpoint store: `lib/db/` using `@langchain/langgraph-checkpoint-sqlite`.
