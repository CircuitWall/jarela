// Curated registry of well-known MCP servers. Surfaced in the UI as a
// "Browse popular" picker so users can install with a click instead of
// typing command/args/env from memory.
//
// Each entry can declare `variables` — placeholders inside the spec
// (formatted as `${name}`) that the UI prompts for before saving. Common
// patterns: a path for filesystem-style servers, an API key for vendor
// servers, a connection string for DB servers.

export interface RegistryVariable {
  /** Unique key used as `${key}` in spec strings or env values. */
  key: string;
  /** Human-readable label shown in the form. */
  label: string;
  /** Placeholder text / example value. */
  placeholder?: string;
  /** If true, hide the field as a password. */
  secret?: boolean;
  /** Pre-filled default. User can edit. */
  default?: string;
}

export interface RegistryEntry {
  /** Slug used as the default MCP server name. */
  id: string;
  /** Display name in the picker. */
  name: string;
  /** One-line description. */
  description: string;
  /** Coarse grouping in the picker UI. */
  category: "Local" | "Web" | "Data" | "Productivity" | "Search" | "Cloud" | "Corporate";
  /** Author label (helps users gauge trust). */
  source: "Official" | "Community" | "Vendor";
  /** Homepage / docs URL — shown as a small "?" link in the picker. */
  url?: string;
  /** Transport. stdio runs a subprocess; http calls a remote SSE/HTTP MCP server. */
  transport: "stdio" | "http";
  /** Spec template. ${var} placeholders are replaced with user input. */
  spec: Record<string, unknown>;
  /** Optional ${} variables collected from the user before saving. */
  variables?: RegistryVariable[];
}

export const MCP_REGISTRY: RegistryEntry[] = [
  // ── Official Anthropic-published servers (most trusted) ─────────────────
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read/write files in a sandboxed directory.",
    category: "Local",
    source: "Official",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    transport: "stdio",
    spec: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "${ROOT_PATH}"],
    },
    variables: [
      { key: "ROOT_PATH", label: "Sandbox root directory", placeholder: "/Users/me/Documents", default: "" },
    ],
  },
  {
    id: "fetch",
    name: "Fetch",
    description: "Robust web page fetcher (handles redirects, encoding).",
    category: "Web",
    source: "Official",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    transport: "stdio",
    spec: {
      command: "uvx",
      args: ["mcp-server-fetch"],
    },
  },
  {
    id: "github",
    name: "GitHub",
    description: "Search code/issues/PRs, read files, manage repos.",
    category: "Productivity",
    source: "Official",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    transport: "stdio",
    spec: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" },
    },
    variables: [
      { key: "GITHUB_TOKEN", label: "GitHub Personal Access Token", placeholder: "ghp_…", secret: true },
    ],
  },
  {
    id: "git",
    name: "Git",
    description: "Read git history, diff, blame for a local repo.",
    category: "Local",
    source: "Official",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    transport: "stdio",
    spec: {
      command: "uvx",
      args: ["mcp-server-git", "--repository", "${REPO_PATH}"],
    },
    variables: [
      { key: "REPO_PATH", label: "Local repository path", placeholder: "/Users/me/code/myrepo" },
    ],
  },
  {
    id: "memory",
    name: "Memory (knowledge graph)",
    description: "Entity/relation memory richer than key-value stores.",
    category: "Data",
    source: "Official",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    transport: "stdio",
    spec: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
    },
  },
  {
    id: "sqlite",
    name: "SQLite",
    description: "Query a local SQLite database with safety rails.",
    category: "Data",
    source: "Official",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite",
    transport: "stdio",
    spec: {
      command: "uvx",
      args: ["mcp-server-sqlite", "--db-path", "${DB_PATH}"],
    },
    variables: [
      { key: "DB_PATH", label: "SQLite database file path", placeholder: "/Users/me/data.db" },
    ],
  },
  {
    id: "postgres",
    name: "Postgres",
    description: "Read-only Postgres queries.",
    category: "Data",
    source: "Official",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    transport: "stdio",
    spec: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres", "${POSTGRES_URL}"],
    },
    variables: [
      { key: "POSTGRES_URL", label: "Postgres connection URL", placeholder: "postgresql://user:pass@host:5432/db", secret: true },
    ],
  },
  {
    id: "puppeteer",
    name: "Puppeteer",
    description: "Real browser automation — JS rendering, screenshots, forms.",
    category: "Web",
    source: "Official",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
    transport: "stdio",
    spec: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    },
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Web search via Brave Search API (free tier available).",
    category: "Search",
    source: "Official",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    transport: "stdio",
    spec: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-brave-search"],
      env: { BRAVE_API_KEY: "${BRAVE_API_KEY}" },
    },
    variables: [
      { key: "BRAVE_API_KEY", label: "Brave Search API key", placeholder: "BSA…", secret: true },
    ],
  },
  {
    id: "google-maps",
    name: "Google Maps",
    description: "Geocoding, directions, place search.",
    category: "Productivity",
    source: "Official",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/google-maps",
    transport: "stdio",
    spec: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-google-maps"],
      env: { GOOGLE_MAPS_API_KEY: "${GOOGLE_MAPS_API_KEY}" },
    },
    variables: [
      { key: "GOOGLE_MAPS_API_KEY", label: "Google Maps API key", placeholder: "AIza…", secret: true },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    description: "Read/post Slack messages with a bot token.",
    category: "Productivity",
    source: "Official",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    transport: "stdio",
    spec: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: {
        SLACK_BOT_TOKEN: "${SLACK_BOT_TOKEN}",
        SLACK_TEAM_ID: "${SLACK_TEAM_ID}",
      },
    },
    variables: [
      { key: "SLACK_BOT_TOKEN", label: "Slack Bot Token", placeholder: "xoxb-…", secret: true },
      { key: "SLACK_TEAM_ID", label: "Slack Team ID", placeholder: "T0…" },
    ],
  },
  {
    id: "time",
    name: "Time",
    description: "Time/timezone helpers + date arithmetic.",
    category: "Local",
    source: "Official",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
    transport: "stdio",
    spec: {
      command: "uvx",
      args: ["mcp-server-time"],
    },
  },

  // ── Corporate / SaaS ────────────────────────────────────────────────────
  {
    id: "atlassian",
    name: "Atlassian (Jira + Confluence)",
    description: "Read/search/update issues, pages, and comments. Single token covers both products.",
    category: "Corporate",
    source: "Community",
    url: "https://github.com/sooperset/mcp-atlassian",
    transport: "stdio",
    spec: {
      command: "uvx",
      args: ["mcp-atlassian"],
      env: {
        JIRA_URL: "${ATLASSIAN_URL}",
        JIRA_USERNAME: "${ATLASSIAN_EMAIL}",
        JIRA_API_TOKEN: "${ATLASSIAN_API_TOKEN}",
        CONFLUENCE_URL: "${ATLASSIAN_URL}/wiki",
        CONFLUENCE_USERNAME: "${ATLASSIAN_EMAIL}",
        CONFLUENCE_API_TOKEN: "${ATLASSIAN_API_TOKEN}",
      },
    },
    variables: [
      { key: "ATLASSIAN_URL", label: "Atlassian site URL", placeholder: "https://your-team.atlassian.net" },
      { key: "ATLASSIAN_EMAIL", label: "Account email", placeholder: "you@company.com" },
      { key: "ATLASSIAN_API_TOKEN", label: "API token (id.atlassian.com → Security → API tokens)", placeholder: "ATATT3xFfGF0…", secret: true },
    ],
  },
  {
    id: "atlassian-remote",
    name: "Atlassian (Remote MCP, OAuth)",
    description: "Atlassian's hosted MCP endpoint. Use for OAuth-based SSO setups where API tokens are restricted.",
    category: "Corporate",
    source: "Vendor",
    url: "https://www.atlassian.com/platform/mcp",
    transport: "http",
    spec: {
      url: "https://mcp.atlassian.com/v1/sse",
      headers: { Authorization: "Bearer ${ATLASSIAN_OAUTH_TOKEN}" },
    },
    variables: [
      { key: "ATLASSIAN_OAUTH_TOKEN", label: "Atlassian OAuth access token", placeholder: "eyJhbGc…", secret: true },
    ],
  },
  {
    id: "bitbucket",
    name: "Bitbucket",
    description: "Search code, view PRs, read repos in Bitbucket Cloud.",
    category: "Corporate",
    source: "Community",
    url: "https://github.com/aashari/mcp-server-atlassian-bitbucket",
    transport: "stdio",
    spec: {
      command: "npx",
      args: ["-y", "@aashari/mcp-server-atlassian-bitbucket"],
      env: {
        ATLASSIAN_BITBUCKET_USERNAME: "${BITBUCKET_USERNAME}",
        ATLASSIAN_BITBUCKET_APP_PASSWORD: "${BITBUCKET_APP_PASSWORD}",
      },
    },
    variables: [
      { key: "BITBUCKET_USERNAME", label: "Bitbucket username", placeholder: "andrew" },
      { key: "BITBUCKET_APP_PASSWORD", label: "App password (Account → App passwords)", placeholder: "ATBB…", secret: true },
    ],
  },
  {
    id: "linear",
    name: "Linear",
    description: "Read/create/update Linear issues, projects, cycles.",
    category: "Corporate",
    source: "Community",
    url: "https://github.com/jerhadf/linear-mcp-server",
    transport: "stdio",
    spec: {
      command: "npx",
      args: ["-y", "linear-mcp-server"],
      env: { LINEAR_API_KEY: "${LINEAR_API_KEY}" },
    },
    variables: [
      { key: "LINEAR_API_KEY", label: "Linear API key (Settings → API)", placeholder: "lin_api_…", secret: true },
    ],
  },
  {
    id: "notion",
    name: "Notion",
    description: "Read/search Notion databases and pages.",
    category: "Corporate",
    source: "Community",
    url: "https://github.com/suekou/mcp-notion-server",
    transport: "stdio",
    spec: {
      command: "npx",
      args: ["-y", "@suekou/mcp-notion-server"],
      env: { NOTION_API_TOKEN: "${NOTION_API_TOKEN}" },
    },
    variables: [
      { key: "NOTION_API_TOKEN", label: "Notion integration token", placeholder: "secret_…", secret: true },
    ],
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Inspect Sentry issues, events, releases.",
    category: "Corporate",
    source: "Official",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/sentry",
    transport: "stdio",
    spec: {
      command: "uvx",
      args: ["mcp-server-sentry", "--auth-token", "${SENTRY_AUTH_TOKEN}"],
    },
    variables: [
      { key: "SENTRY_AUTH_TOKEN", label: "Sentry auth token (Settings → Auth Tokens)", placeholder: "sntrys_…", secret: true },
    ],
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Manage Workers, KV, R2, D1, and other Cloudflare resources.",
    category: "Cloud",
    source: "Vendor",
    url: "https://github.com/cloudflare/mcp-server-cloudflare",
    transport: "stdio",
    spec: {
      command: "npx",
      args: ["-y", "@cloudflare/mcp-server-cloudflare", "init"],
    },
  },

  // ── private (private-mcp-servers) ──────────────────────────────
  // These aren't on npm — clone the repo and build locally before use:
  //   git clone git@github.com:internal/private-mcp-servers.git
  //   cd private-mcp-servers && pnpm install
  //   (sonatype) pnpm --filter sonatype-mcp-server run build
  //   (mcp-docs) cd mcp-docs && npm install && npm run build
  // Then paste the absolute clone path into REPO_PATH below.
  {
    id: "private-sonatype",
    name: "Sonatype (private)",
    description:
      "Vulnerability reports from ae-saas.sonatype.app. private — clone private-mcp-servers and build before use.",
    category: "Corporate",
    source: "Vendor",
    url: "https://github.com/internal/private-mcp-servers/tree/master/sonatype",
    transport: "stdio",
    spec: {
      command: "node",
      args: ["${REPO_PATH}/sonatype/dist/index.js"],
      env: {
        SONATYPE_USER: "${SONATYPE_USER}",
        SONATYPE_PASSWORD: "${SONATYPE_PASSWORD}",
      },
    },
    variables: [
      {
        key: "REPO_PATH",
        label: "Path to private-mcp-servers checkout",
        placeholder: "/Users/me/code/private-mcp-servers",
        // ${HOME} is expanded to the server's homedir() in the registry
        // route. `npm run install:private-mcps` clones to exactly this path,
        // so the picker form pre-fills with no user editing required.
        default: "${HOME}/.jarela/external/private-mcp-servers",
      },
      { key: "SONATYPE_USER", label: "Sonatype username" },
      { key: "SONATYPE_PASSWORD", label: "Sonatype password", secret: true },
    ],
  },
  {
    id: "private-mcp-docs",
    name: "MCP Docs (private)",
    description:
      "Fetch and parse llms.txt-style documentation (Stripe, etc.). private — clone private-mcp-servers and build before use.",
    category: "Productivity",
    source: "Vendor",
    url: "https://github.com/internal/private-mcp-servers/tree/master/mcp-docs",
    transport: "stdio",
    spec: {
      command: "node",
      args: ["${REPO_PATH}/mcp-docs/build/index.js"],
    },
    variables: [
      {
        key: "REPO_PATH",
        label: "Path to private-mcp-servers checkout",
        placeholder: "/Users/me/code/private-mcp-servers",
        // ${HOME} is expanded to the server's homedir() in the registry
        // route. `npm run install:private-mcps` clones to exactly this path,
        // so the picker form pre-fills with no user editing required.
        default: "${HOME}/.jarela/external/private-mcp-servers",
      },
    ],
  },
];

// Substitute `${var}` placeholders in a spec object using user-supplied values.
// Walks objects and arrays recursively; leaves non-strings alone.
export function applyVariables(
  spec: Record<string, unknown>,
  values: Record<string, string>,
): Record<string, unknown> {
  return walk(spec) as Record<string, unknown>;

  function walk(node: unknown): unknown {
    if (typeof node === "string") {
      return node.replace(/\$\{(\w+)\}/g, (_, k) => values[k] ?? `\${${k}}`);
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return node;
  }
}
