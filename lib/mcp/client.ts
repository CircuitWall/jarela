import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  listMcpServers,
  setMcpServerError,
  type McpServerRow,
  type McpHttpSpec,
  type McpStdioSpec,
} from "@/lib/stores/mcp-servers";
import { getInjectedSubprocessEnv } from "@/lib/env/allowlist";
import { errorMessage } from "@/lib/utils/error";

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
// Incremented by invalidateMcpTools(); captured by getMcpTools() at the start
// of each async run so a stale in-flight promise can detect it was superseded.
let generation = 0;

export interface McpToolMeta {
  category?: string;
  group?: string;
  credentials_required?: string[];
}
const mcpToolMeta = new Map<string, McpToolMeta>();

/**
 * Return the declared metadata for an MCP tool (category, group,
 * credentials_required). Populated when getMcpTools() connects to servers;
 * sourced from the tool's `metadata` object which @langchain/mcp-adapters
 * populates from the MCP tool's `annotations` field.
 *
 * Returns stale (pre-invalidation) values during reconnect — intentional:
 * stale metadata is better than empty metadata for the credentials badge.
 */
export function getMcpToolMeta(name: string): McpToolMeta | undefined {
  return mcpToolMeta.get(name);
}

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

  const myGen = generation; // capture before async work; invalidation will increment this

  pending = (async () => {
    // Close prior client if we're rebuilding due to a config change.
    if (activeClient) {
      try { await activeClient.close(); } catch { /* swallow */ }
      activeClient = null;
    }

    const { MultiServerMCPClient } = await import("@langchain/mcp-adapters");

    // Connect each server in its own client so one broken server (e.g. missing
    // `uvx` on PATH, bad API key) doesn't poison the others. Previously a
    // single MultiServerMCPClient.getTools() throw would mark ALL enabled
    // servers with the same error message — confusing because the UI showed
    // e.g. google-maps tagged with the `time` server's connection error.
    const tools: StructuredToolInterface[] = [];
    const newMeta = new Map<string, McpToolMeta>(); // built in isolation; written atomically
    const subClients: Array<{ close: () => Promise<void> }> = [];

    for (const row of enabled) {
      let serverConfig: Record<string, unknown>;
      try {
        const spec = JSON.parse(row.spec) as McpStdioSpec | McpHttpSpec;
        if (row.transport === "stdio") {
          const s = spec as McpStdioSpec;
          serverConfig = {
            transport: "stdio",
            command: s.command,
            args: s.args ?? [],
            // Inherit host env (PATH, HOME, proxies, registry configs) and
            // layer spec.env on top. See buildSubprocessEnv below.
            env: buildSubprocessEnv(s.env ?? {}),
          };
        } else {
          const s = spec as McpHttpSpec;
          serverConfig = {
            transport: "http",
            url: s.url,
            headers: s.headers ?? {},
          };
        }
      } catch (err) {
        setMcpServerError(row.name, `bad spec: ${errorMessage(err)}`);
        continue;
      }

      try {
        const client = new MultiServerMCPClient({
          mcpServers: { [row.name]: serverConfig },
          throwOnLoadError: false,
        } as ConstructorParameters<typeof MultiServerMCPClient>[0]);
        const serverTools = (await client.getTools()) as unknown as StructuredToolInterface[];
        tools.push(...serverTools);
        for (const t of serverTools) {
          const raw = (t as { metadata?: Record<string, unknown> }).metadata ?? {};
          // @langchain/mcp-adapters may nest annotations under metadata.annotations
          // or spread them directly into metadata — handle both shapes.
          const ann = (raw.annotations as Record<string, unknown> | undefined) ?? raw;
          newMeta.set(t.name, {
            category: typeof ann.category === "string" ? ann.category : undefined,
            group: typeof ann.group === "string" ? ann.group : undefined,
            credentials_required: Array.isArray(ann.credentials_required)
              ? ann.credentials_required.filter((c): c is string => typeof c === "string")
              : undefined,
          });
        }
        subClients.push(client as unknown as { close: () => Promise<void> });
        setMcpServerError(row.name, null);
      } catch (err) {
        const msg = errorMessage(err);
        console.error(`[mcp] server "${row.name}" failed:`, msg);
        setMcpServerError(row.name, msg);
      }
    }

    // If invalidateMcpTools() was called while we were connecting, our results
    // are stale — discard them and let the next caller reconnect fresh.
    if (generation !== myGen) return cachedTools ?? [];

    // Atomically replace metadata so callers never see a partial update.
    mcpToolMeta.clear();
    for (const [k, v] of newMeta) mcpToolMeta.set(k, v);

    activeClient = {
      close: async () => {
        await Promise.allSettled(subClients.map((c) => c.close()));
      },
    };
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
  pending = null;   // clear dedup guard so the next caller starts a fresh connect
  generation++;     // signal any in-flight promise to discard its writes
  // mcpToolMeta intentionally NOT cleared: stale metadata (category, group,
  // credentials_required) is better than empty during the reconnect window —
  // the credentials badge stays visible instead of silently disappearing.
  // The map is replaced atomically once the new connection completes.
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
  "JARELA_DB_DIR",
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

  // 2. Inject env-sync-managed credentials from the encrypted integration
  //    store. Service-mode installs (launchd, systemd, brew services)
  //    start with no shell env, so ANTHROPIC_API_KEY / GITHUB_TOKEN / …
  //    have to come from the store or downstream tools see nothing. This
  //    layer goes after process.env so that when the store has been
  //    refreshed by env-sync, the new value wins over a stale shell
  //    export.
  for (const [k, v] of Object.entries(getInjectedSubprocessEnv())) {
    out[k] = v;
  }

  // 3. Per-server spec.env layered on top — user's explicit config always
  //    wins. Use this to (a) supply API keys, (b) pin THIS server to a
  //    specific registry without affecting the rest, or (c) unset something
  //    via empty string.
  for (const [k, v] of Object.entries(userEnv)) {
    if (typeof v === "string") out[k] = v;
  }

  return out;
}
