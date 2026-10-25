# ADR-0108: Opt-in DeepSeek Search and Fetch backend

- Status: Accepted
- Date: 2026-10-25

## Context

DeepSeek exposes standalone Search and Fetch APIs, independent of chat
completions. Jarela already exposes permission-gated `web_search` and `web_fetch`
tools. Selecting a chat model must not enable another paid network service.

Official contracts reviewed on 2026-10-25:

- https://api-docs.deepseek.com/guides/search
- https://api-docs.deepseek.com/api/search
- https://api-docs.deepseek.com/api/fetch

## Decision

Use the existing web tools, not a model-adapter search flag. A separate
`deepseek-web` encrypted integration credential explicitly opts these tools in.
Do not reuse the chat credential or `DEEPSEEK_API_KEY` automatically. Removing
the integration restores Firecrawl Search and direct page fetch.

Search accepts a non-blank query of at most 128 Unicode characters, uses
Jarela's existing 1-10 result limit, and normalizes title, source URL, and
snippet. Empty results are valid. Fetch accepts public HTTP(S) URLs without
embedded credentials, up to 8192 characters, and normalizes Markdown content.
Validate response schemas and bound responses to 1 MB before parsing; Fetch
also retains Jarela's configured content byte cap and requested character cap.

Keep HTML requests, Allowed sites (including browser cookies), and private-fetch
overrides on the existing direct-fetch path. Do not forward cookies to
DeepSeek. Apply the existing public-URL guard before sending Fetch requests;
DeepSeek owns remote page retrieval and redirect enforcement, so Jarela cannot
inspect the remote redirect chain. A returned Fetch status of 200 denotes
successful extraction, not an independently observed origin HTTP status.

Use 30-second Search and 120-second Fetch request deadlines. Failures are
sanitized and explicit, with no retries or silent backend failover. Do not
run automatic paid probes: setup guidance requires a user-approved search
and fetch with verified provider, source URLs, and non-empty content.

## Consequences

- Existing tool permissions and read capability remain in force.
- Any tool-capable model can use this backend; model-native search badges
  remain unchanged.
- The stored credential is an explicit opt-in, not proof of working API access.
- Search and Fetch are billed separately from model tokens. DeepSeek documents
  $0.75 per 1,000 successful requests for each API; empty searches and failed
  requests are not billed. Check current vendor terms before enabling.
- Gemini native grounding remains a separate provider-adapter feature.
