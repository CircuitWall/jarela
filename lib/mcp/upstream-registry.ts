// Fetches and translates entries from the official MCP Registry
// (https://registry.modelcontextprotocol.io). The upstream `server.json`
// shape is normalised into our local `RegistryEntry` so the picker UI and
// `applyVariables` keep working unchanged.
//
// See ADR-0013 for why we replaced the static curated list with online
// discovery.
//
// Upstream schema reference:
//   https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
//   https://registry.modelcontextprotocol.io/docs

import { z } from "zod";
import type { RegistryEntry, RegistryVariable } from "./registry";

const REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0.1";
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 15 * 60 * 1000;

// ── Upstream schema ────────────────────────────────────────────────────────
// Permissive on purpose: the registry adds fields over time, and we'd rather
// pass through unknowns than reject a server because the schema bumped a minor
// version.

const ArgumentZ = z.object({
  type: z.enum(["positional", "named"]).optional(),
  name: z.string().optional(),
  value: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  default: z.string().optional(),
  description: z.string().optional(),
});

const EnvVarZ = z.object({
  name: z.string(),
  description: z.string().optional(),
  default: z.string().optional(),
  isSecret: z.boolean().optional(),
  isRequired: z.boolean().optional(),
  format: z.string().optional(),
  value: z.string().optional(),
});

const HeaderZ = z.object({
  name: z.string(),
  value: z.string().optional(),
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
});

const PackageZ = z.object({
  registryType: z.string(),
  registryBaseUrl: z.string().optional(),
  identifier: z.string(),
  version: z.string().optional(),
  runtimeHint: z.string().optional(),
  transport: z.object({ type: z.string() }).optional(),
  runtimeArguments: z.array(ArgumentZ).optional(),
  packageArguments: z.array(ArgumentZ).optional(),
  environmentVariables: z.array(EnvVarZ).optional(),
});

const RemoteZ = z.object({
  type: z.string(),
  url: z.string(),
  headers: z.array(HeaderZ).optional(),
});

const ServerZ = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  repository: z.object({ url: z.string().optional(), source: z.string().optional() }).optional(),
  packages: z.array(PackageZ).optional(),
  remotes: z.array(RemoteZ).optional(),
});

const EntryZ = z.object({
  server: ServerZ,
  _meta: z
    .object({
      "io.modelcontextprotocol.registry/official": z
        .object({ status: z.string().optional(), isLatest: z.boolean().optional() })
        .partial()
        .optional(),
    })
    .partial()
    .optional(),
});

const ListResponseZ = z.object({
  servers: z.array(EntryZ).optional(),
  metadata: z.object({ nextCursor: z.string().optional(), count: z.number().optional() }).partial().optional(),
});

type UpstreamServer = z.infer<typeof ServerZ>;
type UpstreamEntry = z.infer<typeof EntryZ>;

// ── In-memory TTL cache ────────────────────────────────────────────────────

interface CacheEntry<T> { value: T; expiresAt: number }
const listCache = new Map<string, CacheEntry<{ entries: RegistryEntry[]; nextCursor?: string }>>();
const detailCache = new Map<string, CacheEntry<RegistryEntry | null>>();

function getCached<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) { map.delete(key); return undefined; }
  return hit.value;
}

function setCached<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
  map.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface SearchOptions {
  q?: string;
  cursor?: string;
  limit?: number;
  fresh?: boolean;
  /** When true, include Community-published entries (default: false — only Official + Vendor). */
  includeCommunity?: boolean;
}

export interface SearchResult {
  entries: RegistryEntry[];
  nextCursor?: string;
}

// Default page size when caller doesn't specify. The upstream registry's own
// default is small (~30); we bump it so that after filtering out community
// entries and sorting by popularity, the first page still feels populated.
const DEFAULT_LIMIT = 100;

export async function searchUpstream(opts: SearchOptions = {}): Promise<SearchResult> {
  const includeCommunity = opts.includeCommunity === true;
  const key = `${opts.q ?? ""}|${opts.cursor ?? ""}|${opts.limit ?? ""}|${includeCommunity ? "all" : "verified"}`;
  if (!opts.fresh) {
    const cached = getCached(listCache, key);
    if (cached) return cached;
  }

  const url = new URL(`${REGISTRY_BASE}/servers`);
  if (opts.q) url.searchParams.set("search", opts.q);
  if (opts.cursor) url.searchParams.set("cursor", opts.cursor);
  url.searchParams.set("limit", String(opts.limit ?? DEFAULT_LIMIT));

  const raw = await fetchJson(url);
  const parsed = ListResponseZ.safeParse(raw);
  if (!parsed.success) throw new Error(`registry response failed validation: ${parsed.error.message}`);

  // Pair each translated entry with its fully-qualified upstream namespace
  // so popularity scoring can read it (RegistryEntry.id is just the last
  // path segment and loses the publisher prefix).
  const translated = (parsed.data.servers ?? [])
    .filter((e) => (e._meta?.["io.modelcontextprotocol.registry/official"]?.status ?? "active") === "active")
    .map((e) => {
      const entry = toRegistryEntry(e);
      return entry ? { entry, qualifiedName: e.server.name } : null;
    })
    .filter((x): x is { entry: RegistryEntry; qualifiedName: string } => x !== null);

  const filtered = includeCommunity
    ? translated
    : translated.filter((x) => x.entry.source !== "Community");

  // Sort by popularity score (desc), then alphabetically. Stable within a
  // page; pagination still works because we don't drop the upstream cursor.
  filtered.sort((a, b) => {
    const ds = popularityScore(b.entry, b.qualifiedName) - popularityScore(a.entry, a.qualifiedName);
    if (ds !== 0) return ds;
    return a.entry.name.localeCompare(b.entry.name);
  });

  const entries = filtered.map((x) => x.entry);
  const result: SearchResult = { entries, nextCursor: parsed.data.metadata?.nextCursor };
  setCached(listCache, key, result);
  return result;
}

export async function getUpstreamByName(serverName: string, fresh = false): Promise<RegistryEntry | null> {
  if (!fresh) {
    const cached = getCached(detailCache, serverName);
    if (cached !== undefined) return cached;
  }
  const url = new URL(`${REGISTRY_BASE}/servers/${encodeURIComponent(serverName)}/versions/latest`);
  const raw = await fetchJson(url).catch(() => null);
  if (!raw) { setCached(detailCache, serverName, null); return null; }
  const parsed = EntryZ.safeParse(raw);
  if (!parsed.success) { setCached(detailCache, serverName, null); return null; }
  const entry = toRegistryEntry(parsed.data);
  setCached(detailCache, serverName, entry);
  return entry;
}

async function fetchJson(url: URL): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "Jarela/1.0 (+mcp-registry)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`MCP registry ${url.pathname} returned ${res.status}`);
  return res.json();
}

// ── Translation ────────────────────────────────────────────────────────────

export function toRegistryEntry(entry: UpstreamEntry): RegistryEntry | null {
  const s = entry.server;
  const id = slugId(s.name);
  const display = s.title ?? lastSegment(s.name);
  const description = s.description ?? "";

  // Prefer stdio packages (npm > pypi > oci > others); fall back to remote.
  const pkg = pickPackage(s.packages);
  if (pkg) {
    const built = buildStdio(pkg);
    if (!built) return null;
    return {
      id,
      name: display,
      description,
      category: inferCategory(s.name),
      source: inferSource(s.name),
      url: s.repository?.url,
      transport: "stdio",
      spec: built.spec,
      variables: dedupeVars(built.variables),
    };
  }

  const remote = s.remotes?.find((r) => r.type === "streamable-http") ?? s.remotes?.[0];
  if (remote) {
    const built = buildHttp(remote);
    return {
      id,
      name: display,
      description,
      category: inferCategory(s.name),
      source: inferSource(s.name),
      url: s.repository?.url,
      transport: "http",
      spec: built.spec,
      variables: dedupeVars(built.variables),
    };
  }

  return null;
}

function pickPackage(pkgs: UpstreamServer["packages"]): NonNullable<UpstreamServer["packages"]>[number] | undefined {
  if (!pkgs?.length) return undefined;
  const order = ["npm", "pypi", "oci", "mcpb"];
  return [...pkgs].sort((a, b) => {
    const ai = order.indexOf(a.registryType); const bi = order.indexOf(b.registryType);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  })[0];
}

interface Built { spec: Record<string, unknown>; variables: RegistryVariable[] }

function buildStdio(pkg: NonNullable<UpstreamServer["packages"]>[number]): Built | null {
  const variables: RegistryVariable[] = [];
  const env: Record<string, string> = {};
  for (const v of pkg.environmentVariables ?? []) {
    if (isUserSupplied(v)) {
      variables.push({
        key: v.name,
        label: v.description ?? v.name,
        placeholder: placeholderFor(v.format, v.name),
        secret: v.isSecret,
        default: v.default,
      });
      env[v.name] = `\${${v.name}}`;
    } else if (v.value !== undefined) {
      env[v.name] = renderTemplate(v.value, variables);
    } else if (v.default !== undefined) {
      env[v.name] = v.default;
    }
  }

  const runtimeArgs = renderArgs(pkg.runtimeArguments, variables);
  const packageArgs = renderArgs(pkg.packageArguments, variables);

  let command: string;
  let args: string[];
  switch (pkg.registryType) {
    case "npm": {
      command = pkg.runtimeHint ?? "npx";
      const ident = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier;
      const hasDashY = runtimeArgs.includes("-y");
      args = [...(hasDashY ? [] : ["-y"]), ...runtimeArgs, ident, ...packageArgs];
      break;
    }
    case "pypi": {
      command = pkg.runtimeHint ?? "uvx";
      args = [...runtimeArgs, pkg.identifier, ...packageArgs];
      break;
    }
    case "oci": {
      command = pkg.runtimeHint ?? "docker";
      const envFlags = Object.keys(env).flatMap((k) => ["-e", k]);
      args = ["run", "-i", "--rm", ...envFlags, ...runtimeArgs, pkg.identifier, ...packageArgs];
      break;
    }
    default:
      return null;
  }

  const spec: Record<string, unknown> = { command, args };
  if (Object.keys(env).length > 0) spec.env = env;
  return { spec, variables };
}

function buildHttp(remote: NonNullable<UpstreamServer["remotes"]>[number]): Built {
  const variables: RegistryVariable[] = [];
  const headers: Record<string, string> = {};
  for (const h of remote.headers ?? []) {
    if (h.value !== undefined) {
      headers[h.name] = renderTemplate(h.value, variables, h.isSecret);
    } else if (isUserSupplied(h)) {
      variables.push({ key: h.name, label: h.description ?? h.name, secret: h.isSecret });
      headers[h.name] = `\${${h.name}}`;
    }
  }
  const spec: Record<string, unknown> = { url: remote.url };
  if (Object.keys(headers).length > 0) spec.headers = headers;
  return { spec, variables };
}

function renderArgs(
  args: NonNullable<UpstreamServer["packages"]>[number]["runtimeArguments"],
  variables: RegistryVariable[],
): string[] {
  const out: string[] = [];
  for (const a of args ?? []) {
    if (a.type === "named" && a.name) out.push(a.name);
    if (a.value !== undefined) {
      out.push(renderTemplate(a.value, variables, a.isSecret));
    } else if (isUserSupplied(a)) {
      const key = a.name ?? `ARG_${out.length}`;
      variables.push({ key, label: a.description ?? key, secret: a.isSecret, default: a.default });
      out.push(`\${${key}}`);
    } else if (a.default !== undefined) {
      out.push(a.default);
    }
  }
  return out;
}

// Upstream uses `{varName}` templates inside string values. Convert to our
// `${VARNAME}` placeholder syntax and register each referenced variable.
function renderTemplate(value: string, variables: RegistryVariable[], secret?: boolean): string {
  return value.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, name: string) => {
    const key = name.toUpperCase();
    if (!variables.find((v) => v.key === key)) {
      variables.push({ key, label: name, secret });
    }
    return `\${${key}}`;
  });
}

function isUserSupplied(field: { isRequired?: boolean; isSecret?: boolean; default?: string; value?: string }): boolean {
  if (field.value !== undefined) return false;
  if (field.isRequired) return true;
  if (field.isSecret) return true;
  return field.default === undefined;
}

function dedupeVars(vars: RegistryVariable[]): RegistryVariable[] | undefined {
  if (vars.length === 0) return undefined;
  const map = new Map<string, RegistryVariable>();
  for (const v of vars) {
    const existing = map.get(v.key);
    if (!existing) { map.set(v.key, v); continue; }
    map.set(v.key, {
      key: v.key,
      label: existing.label.length >= v.label.length ? existing.label : v.label,
      placeholder: existing.placeholder ?? v.placeholder,
      secret: existing.secret || v.secret,
      default: existing.default ?? v.default,
    });
  }
  return Array.from(map.values());
}

function placeholderFor(format: string | undefined, name: string): string | undefined {
  if (format === "filepath") return "/path/to/file";
  if (format === "url") return "https://example.com";
  if (/token|key|secret|password/i.test(name)) return "••••••••";
  return undefined;
}

function slugId(name: string): string {
  const seg = lastSegment(name);
  return seg.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function lastSegment(name: string): string {
  const i = name.lastIndexOf("/");
  return i === -1 ? name : name.slice(i + 1);
}

function inferCategory(name: string): RegistryEntry["category"] {
  const n = name.toLowerCase();
  if (/search|brave|google-?search|kagi|exa/.test(n)) return "Search";
  if (/postgres|sqlite|mysql|mongo|redis|database|memory/.test(n)) return "Data";
  if (/playwright|puppeteer|browser|fetch|web/.test(n)) return "Web";
  if (/slack|notion|linear|atlassian|jira|confluence|github|gitlab|bitbucket|sentry/.test(n)) return "Productivity";
  if (/cloudflare|aws|gcp|azure|vercel|supabase/.test(n)) return "Cloud";
  if (/filesystem|git|time|local|shell/.test(n)) return "Local";
  return "Productivity";
}

// GitHub orgs whose `io.github.<org>/...` namespaces we treat as Vendor-grade.
// The MCP registry verifies these via OIDC, so the namespace really does
// belong to the named org — but namespace existence alone doesn't imply
// trustworthiness. This allowlist keeps the picker focused on first-party
// integrations from established vendors.
const VENDOR_GITHUB_ORGS = new Set<string>([
  "anthropic",
  "anthropics",
  "openai",
  "googleapis",
  "google",
  "microsoft",
  "azure",
  "github",
  "cloudflare",
  "stripe",
  "sentry",
  "sentry-mcp",
  "vercel",
  "supabase",
  "neondatabase",
  "upstash",
  "redis",
  "mongodb",
  "elastic",
  "hashicorp",
  "docker",
  "linear",
  "notionhq",
  "slack",
  "atlassian",
  "shopify",
  "twilio",
  "discordapp",
  "deepmind",
  "huggingface",
  "perplexityai",
  "brave",
  "exa-labs",
  "firecrawl",
  "qdrant",
  "pinecone-io",
  "chroma-core",
]);

// Roughly-popular GitHub orgs get a boost so they float to the top of the
// picker. Not exhaustive — just enough to surface household names first.
const VENDOR_POPULARITY_BOOST = new Map<string, number>([
  ["anthropic", 60], ["anthropics", 60],
  ["openai", 55],
  ["github", 55],
  ["google", 50], ["googleapis", 50], ["deepmind", 45],
  ["microsoft", 50], ["azure", 45],
  ["cloudflare", 45],
  ["stripe", 40],
  ["vercel", 40],
  ["supabase", 35],
  ["notionhq", 35],
  ["slack", 35],
  ["linear", 30],
  ["sentry", 30], ["sentry-mcp", 30],
  ["atlassian", 25],
  ["shopify", 25],
  ["huggingface", 25],
  ["docker", 25],
  ["hashicorp", 25],
  ["twilio", 20],
  ["mongodb", 20], ["redis", 20], ["elastic", 20],
  ["neondatabase", 20], ["upstash", 20],
  ["perplexityai", 20], ["brave", 20], ["exa-labs", 20],
]);

function inferSource(name: string): RegistryEntry["source"] {
  // Reference servers maintained by the MCP team.
  if (/^io\.github\.modelcontextprotocol\//.test(name)) return "Official";
  if (/^io\.modelcontextprotocol\//.test(name)) return "Official";
  // Domain-verified namespaces (`com.<vendor>/`) imply a real company
  // published this entry — treat as Vendor.
  if (/^com\.[a-z0-9-]+\//.test(name)) return "Vendor";
  // GitHub-namespace entries are only Vendor when the org is on the
  // allowlist; anyone else's GitHub repo counts as Community.
  const m = /^io\.github\.([a-z0-9-]+)\//.exec(name);
  if (m && VENDOR_GITHUB_ORGS.has(m[1])) return "Vendor";
  return "Community";
}

function popularityScore(entry: RegistryEntry, qualifiedName: string): number {
  // Official servers always rank highest.
  if (entry.source === "Official") return 1000;
  if (entry.source === "Community") return 0;
  // Vendor base score + per-org boost from the popularity table. Match
  // against the fully-qualified upstream name (e.g. `io.github.cloudflare/…`)
  // since `entry.id` only carries the last path segment.
  let score = 100;
  const m =
    /^io\.github\.([a-z0-9-]+)\//.exec(qualifiedName) ??
    /^com\.([a-z0-9-]+)\//.exec(qualifiedName);
  if (m) score += VENDOR_POPULARITY_BOOST.get(m[1]) ?? 0;
  return score;
}
