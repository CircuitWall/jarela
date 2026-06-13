# @circuitwall/github-langchain

LangChain tools for the GitHub REST API — direct REST calls, no MCP, no `gh` CLI, proxy-aware.

> Extracted from [Jarela](https://github.com/CircuitWall/jarela). Works in any
> Node 20+ LangChain.js / LangGraph project. Inherits whatever HTTP proxy +
> CA bundle the host runtime configures, so it works on locked-down corp
> networks where the MCP install path is blocked.

## Install

```bash
npm install @circuitwall/github-langchain @langchain/core zod
```

`@langchain/core` and `zod` are peer dependencies — bring your own version.

## Quick start

```ts
import {
  setAuthResolver,
  githubGetRepoTool,
  githubSearchIssuesTool,
  githubTools,
} from "@circuitwall/github-langchain";

// Option A: rely on env vars (GITHUB_TOKEN or GH_TOKEN). Nothing to do.

// Option B: plug in your own credential source (vault, UI form, …).
setAuthResolver(() => ({
  token: process.env.MY_GITHUB_TOKEN ?? "",
}));

// Use individual tools …
const result = await githubGetRepoTool.invoke({
  owner: "CircuitWall",
  repo: "jarela",
});

// … or pass the whole array to a LangGraph agent.
const agent = await createReactAgent({ llm, tools: [...githubTools] });
```

## What's in the box

22 tools covering the GitHub REST API.

### Issues
- `github_search_issues` — full GitHub search syntax (issues + PRs)
- `github_get_issue`
- `github_create_issue`
- `github_update_issue` — title / body / labels / state
- `github_add_comment`
- `github_list_issue_comments`

### Pull requests
- `github_list_pulls`
- `github_get_pull` — full detail (mergeable, additions, reviews)
- `github_create_pull`
- `github_update_pull`
- `github_merge_pull` — execute capability
- `github_request_reviewers`
- `github_create_review` — APPROVE / REQUEST_CHANGES / COMMENT
- `github_list_pull_files` — with capped patch text
- `github_list_pull_reviews`

### Repo content
- `github_get_repo`
- `github_list_branches`
- `github_get_file` — capped UTF-8 read, binary-aware
- `github_search_code`

## Capability groups

For tool-policy systems that need read / write / execute partitions:

```ts
import {
  githubReadTools,    // 11 read-only tools
  githubWriteTools,   // 7 mutating tools (issues + PRs)
  githubExecuteTools, // 1 merge tool
} from "@circuitwall/github-langchain";
```

`github_merge_pull` is in `execute` (not `write`) because merging a PR
triggers CI, deploys, and downstream automation — a different blast radius
than editing an issue title.

## Low-level escape hatch

For endpoints not yet wrapped as tools:

```ts
import { githubFetch, resolveGithubAuthFromEnv } from "@circuitwall/github-langchain";

const auth = resolveGithubAuthFromEnv();
if (!("error" in auth)) {
  const data = await githubFetch(auth, "/user");
}
```

## Pure helpers

Exported for reuse outside the LangChain tool wrappers:

- `truncate(text, cap)` — pure-fn body capping (`{text, truncated}`)
- `decodeContentsBlob(content, encoding)` — decode `/contents/{path}` blob,
  detect binary, return `{binary, text?, size_bytes}`

## API notes

- **Token scopes:** `repo` covers private + public repo content + issues + PRs;
  `read:org` is needed for team-based reviewer requests. Fine-grained tokens
  must explicitly grant each resource.
- **Code search rate limits:** GitHub's `/search/code` endpoint has stricter
  limits (10/min unauthenticated, 30/min authenticated) than the rest of the
  REST API.
- **`mergeable: null`:** On a freshly-pushed PR, GitHub computes mergeability
  asynchronously. The first call to `github_get_pull` may return `null`; call
  again after a few seconds.

## License

Apache-2.0
