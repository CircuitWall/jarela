import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  listMcpServers,
  setMcpServerError,
  type McpServerRow,
  type McpHttpSpec,
  type McpStdioSpec,
} from "@/lib/stores/mcp-servers";

// Singleton MCP client manager. Connects to enabled servers on first access,
// caches the resulting StructuredTools, and invalidates on configuration
// changes (when the API CRUD endpoints touch the table they call refresh()).
//
// We intentionally don't keep stdio child processes alive forever — the
// MultiServerMCPClient owns connections, and if a server is disabled or
// removed we close the existing client and rebuild on next access.

let cachedTools: StructuredToolInterface[] | null = null;
let cacheKey = "";          // hash of the enabled server set; cache invalidated on change
let pending: Promise<StructuredToolInterface[]> | null = null;
let activeClient: { close: () => Promise<void> } | null = null;

function specHash(rows: McpServerRow[]): string {
  // Only enabled servers matter. Order by name so the hash is stable.
  return rows
    .filter((r) => r.enabled === 1)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => `${r.name}:${r.transport}:${r.spec}`)
    .join("|");
}

export async function getMcpTools(): Promise<StructuredToolInterface[]> {
  const rows = listMcpServers();
  const enabled = rows.filter((r) => r.enabled === 1);
  const key = specHash(rows);

  if (cachedTools && cacheKey === key) return cachedTools;
  if (pending) return pending;

  if (enabled.length === 0) {
    cachedTools = [];
    cacheKey = key;
    return cachedTools;
  }

  pending = (async () => {
    // Close prior client if we're rebuilding due to a config change.
    if (activeClient) {
      try { await activeClient.close(); } catch { /* swallow */ }
      activeClient = null;
    }

    const { MultiServerMCPClient } = await import("@langchain/mcp-adapters");
    const mcpServers: Record<string, unknown> = {};
    for (const row of enabled) {
      try {
        const spec = JSON.parse(row.spec) as McpStdioSpec | McpHttpSpec;
        if (row.transport === "stdio") {
          const s = spec as McpStdioSpec;
          mcpServers[row.name] = {
            transport: "stdio",
            command: s.command,
            args: s.args ?? [],
            // Build a clean env that points uvx/pip/npm at PUBLIC registries
            // by default, then layer the user's spec.env on top. Without this,
            // corporate setups (e.g. ~/.config/uv/uv.toml pinned to JFrog) leak
            // into the subprocess and break installs for off-VPN users.
            env: buildSubprocessEnv(s.env ?? {}),
          };
        } else {
          const s = spec as McpHttpSpec;
          mcpServers[row.name] = {
            transport: "http",
            url: s.url,
            headers: s.headers ?? {},
          };
        }
      } catch (err) {
        setMcpServerError(row.name, `bad spec: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const client = new MultiServerMCPClient({
      mcpServers,
      // If one server fails, skip it instead of throwing — we want partial success.
      throwOnLoadError: false,
    } as ConstructorParameters<typeof MultiServerMCPClient>[0]);

    let tools: StructuredToolInterface[] = [];
    try {
      tools = (await client.getTools()) as unknown as StructuredToolInterface[];
      // Clear last_error on every server we successfully connected to.
      for (const row of enabled) setMcpServerError(row.name, null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[mcp] getTools failed:", msg);
      // Couldn't enumerate tools at all — mark all servers as errored so the UI shows it.
      for (const row of enabled) setMcpServerError(row.name, msg);
    }

    activeClient = client as unknown as { close: () => Promise<void> };
    cachedTools = tools;
    cacheKey = key;
    return tools;
  })();

  try {
    return await pending;
  } finally {
    pending = null;
  }
}

// Called by API endpoints when a server is added/edited/deleted/toggled so
// the next getAllTools() call re-resolves connections.
export function invalidateMcpTools(): void {
  cachedTools = null;
  cacheKey = "";
  if (activeClient) {
    activeClient.close().catch(() => { /* */ });
    activeClient = null;
  }
}

// ── Subprocess environment ──────────────────────────────────────────────────
// Be transparent: whatever the host can reach, the subprocess can reach.
//
// Why this design:
//   - On a clean machine (no JFrog, no special config), uv/npm fall through to
//     their public defaults. Nothing extra needed.
//   - On a corporate machine (JFrog or Artifactory in env / ~/.config/uv/uv.toml /
//     ~/.npmrc), public PyPI/npm are usually blocked at the network layer.
//     The user's existing config is the ONLY thing that works — so inherit it.
//   - Per-server overrides still work: spec.env wins over inherited env, so a
//     user who wants this specific server pinned to a custom registry can do
//     so without affecting everything else.
//
// The MCP SDK's default behavior (a curated minimal env) breaks corporate
// installs because it strips registry env vars; we explicitly opt out of that.

// Only a few env vars are worth scrubbing — the ones that actively confuse
// stdio MCP processes or leak our internal state. Everything else flows.
const SCRUBBED_VARS = new Set([
  // Our own DB path — irrelevant to MCP servers, and exposes our layout.
  "LANGGUI_DB_DIR",
  // Defensive: don't leak npm/yarn auth tokens into a stdio child unless
  // the server explicitly opted in via spec.env. (Most public MCP packages
  // don't need auth to install.)
  "NPM_TOKEN", "NODE_AUTH_TOKEN",
]);

function buildSubprocessEnv(userEnv: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};

  // 1. Inherit the host process env wholesale. This carries through:
  //    - PATH (so uvx, npx, python, node are findable)
  //    - HOME (so uv/pip/npm read user-level config files like ~/.config/uv/uv.toml,
  //      ~/.npmrc, ~/.pip/pip.conf — which may pin JFrog, Artifactory, etc.)
  //    - HTTP_PROXY / HTTPS_PROXY / NO_PROXY (corporate proxy routing)
  //    - UV_INDEX_URL / PIP_INDEX_URL / npm_config_registry if the user set
  //      them — letting their JFrog or Artifactory setup work transparently
  //    - Locale, terminal, etc.
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (SCRUBBED_VARS.has(k)) continue;
    out[k] = v;
  }

  // 2. Per-server spec.env layered on top — user's explicit config always
  //    wins. Use this to (a) supply API keys, (b) pin THIS server to a
  //    specific registry without affecting the rest, or (c) unset something
  //    via empty string.
  for (const [k, v] of Object.entries(userEnv)) {
    if (typeof v === "string") out[k] = v;
  }

  return out;
}
