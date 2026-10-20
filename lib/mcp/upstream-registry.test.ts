import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importServerJson, searchUpstream } from "./upstream-registry";

// Build a minimal upstream `/v0.1/servers` payload. Mirrors the shape
// the registry actually returns (see ServerZ / EntryZ in upstream-registry.ts).
function serverEntry(opts: {
  name: string;
  description?: string;
  pkgIdentifier?: string;
  isLatest?: boolean;
  status?: string;
}): unknown {
  return {
    server: {
      name: opts.name,
      title: opts.name.split("/").pop(),
      description: opts.description ?? "",
      version: "1.0.0",
      packages: [
        {
          registryType: "npm",
          identifier: opts.pkgIdentifier ?? "some-mcp",
          version: "1.0.0",
          transport: { type: "stdio" },
        },
      ],
    },
    _meta: {
      "io.modelcontextprotocol/official": undefined,
      "io.modelcontextprotocol.registry/official": {
        status: opts.status ?? "active",
        isLatest: opts.isLatest ?? true,
      },
    },
  };
}

interface FetchCapture { url: URL; init?: RequestInit }
const fetchCalls: FetchCapture[] = [];
let fetchResponse: { status: number; body: unknown } = {
  status: 200,
  body: { servers: [], metadata: {} },
};

function installFetchMock(): void {
  fetchCalls.length = 0;
  vi.stubGlobal("fetch", async (input: URL | string | Request, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    fetchCalls.push({ url, init });
    return {
      ok: fetchResponse.status >= 200 && fetchResponse.status < 300,
      status: fetchResponse.status,
      json: async () => fetchResponse.body,
    } as Response;
  });
}

beforeEach(() => {
  fetchResponse = { status: 200, body: { servers: [], metadata: {} } };
  installFetchMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchUpstream — limit clamping (v1.10.0 regression)", () => {
  it("clamps caller-requested limit to 100 so upstream never returns 422", async () => {
    await searchUpstream({ limit: 500, fresh: true });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url.searchParams.get("limit")).toBe("100");
  });

  it("uses the default page size (100) when no limit supplied", async () => {
    await searchUpstream({ fresh: true });
    expect(fetchCalls[0]!.url.searchParams.get("limit")).toBe("100");
  });

  it("respects a smaller caller-requested limit untouched", async () => {
    await searchUpstream({ limit: 25, fresh: true });
    expect(fetchCalls[0]!.url.searchParams.get("limit")).toBe("25");
  });

  it("propagates the upstream HTTP status on a non-OK response", async () => {
    fetchResponse = { status: 422, body: { error: "limit out of range" } };
    await expect(searchUpstream({ limit: 200, fresh: true })).rejects.toThrow(/422/);
  });
});

describe("searchUpstream — wire surface", () => {
  it("forwards search/cursor params to the registry URL", async () => {
    await searchUpstream({ q: "github", cursor: "abc", limit: 10, fresh: true });
    const url = fetchCalls[0]!.url;
    expect(url.pathname).toBe("/v0.1/servers");
    expect(url.searchParams.get("search")).toBe("github");
    expect(url.searchParams.get("cursor")).toBe("abc");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("returns the upstream nextCursor for pagination", async () => {
    fetchResponse = {
      status: 200,
      body: { servers: [], metadata: { nextCursor: "next-page-token" } },
    };
    const result = await searchUpstream({ fresh: true });
    expect(result.nextCursor).toBe("next-page-token");
  });
});

describe("searchUpstream — visibility filters", () => {
  it("drops archived / non-active servers", async () => {
    fetchResponse = {
      status: 200,
      body: {
        servers: [
          serverEntry({ name: "io.github.modelcontextprotocol/active-one" }),
          serverEntry({ name: "io.github.modelcontextprotocol/archived", status: "deleted" }),
        ],
        metadata: {},
      },
    };
    const result = await searchUpstream({ fresh: true });
    const names = result.entries.map((e) => e.id);
    expect(names).toContain("active-one");
    expect(names).not.toContain("archived");
  });

  it("drops non-latest versions to prevent duplicate rows", async () => {
    fetchResponse = {
      status: 200,
      body: {
        servers: [
          serverEntry({ name: "io.github.modelcontextprotocol/svr-latest", isLatest: true }),
          serverEntry({ name: "io.github.modelcontextprotocol/svr-old", isLatest: false }),
        ],
        metadata: {},
      },
    };
    const result = await searchUpstream({ fresh: true });
    const names = result.entries.map((e) => e.id);
    expect(names).toContain("svr-latest");
    expect(names).not.toContain("svr-old");
  });

  it("restricts to the curated allowlist by default", async () => {
    fetchResponse = {
      status: 200,
      body: {
        servers: [
          serverEntry({ name: "io.github.modelcontextprotocol/curated-mcp" }),
          serverEntry({ name: "io.github.random-user/random-mcp" }),
        ],
        metadata: {},
      },
    };
    const result = await searchUpstream({ fresh: true });
    const names = result.entries.map((e) => e.id);
    expect(names).toContain("curated-mcp");
    expect(names).not.toContain("random-mcp");
  });

  it("includes non-curated entries when curatedOnly: false", async () => {
    fetchResponse = {
      status: 200,
      body: {
        servers: [
          serverEntry({ name: "io.github.modelcontextprotocol/curated-mcp" }),
          serverEntry({ name: "io.github.random-user/random-mcp" }),
        ],
        metadata: {},
      },
    };
    // Bypass the verified-source filter too, otherwise `random-user` (a
    // non-allowlisted GitHub org → Community) is stripped before the
    // curated check even runs.
    const result = await searchUpstream({ curatedOnly: false, includeCommunity: true, fresh: true });
    const names = result.entries.map((e) => e.id);
    expect(names).toContain("curated-mcp");
    expect(names).toContain("random-mcp");
  });
});

describe("searchUpstream — caching", () => {
  it("caches responses across identical calls", async () => {
    fetchResponse = {
      status: 200,
      body: {
        servers: [serverEntry({ name: "io.github.modelcontextprotocol/cacheable" })],
        metadata: {},
      },
    };
    const cacheKey = { q: "cache-test", fresh: true };
    await searchUpstream(cacheKey);
    expect(fetchCalls).toHaveLength(1);
    await searchUpstream({ q: "cache-test" });
    expect(fetchCalls).toHaveLength(1);
  });

  it("bypasses the cache when fresh: true", async () => {
    fetchResponse = {
      status: 200,
      body: {
        servers: [serverEntry({ name: "io.github.modelcontextprotocol/fresh" })],
        metadata: {},
      },
    };
    const cacheKey = { q: "fresh-test", fresh: true };
    await searchUpstream(cacheKey);
    expect(fetchCalls).toHaveLength(1);
    await searchUpstream(cacheKey);
    expect(fetchCalls).toHaveLength(2);
  });
});

describe("importServerJson", () => {
  it("imports a standard npm manifest with required secret environment input", () => {
    const entry = importServerJson({
      name: "io.example/weather",
      title: "Weather",
      version: "1.0.0",
      packages: [{
        registryType: "npm",
        identifier: "@example/weather",
        version: "1.0.0",
        transport: { type: "stdio" },
        environmentVariables: [{ name: "API_TOKEN", isRequired: true, isSecret: true }],
      }],
    });

    expect(entry.transport).toBe("stdio");
    expect(entry.spec).toMatchObject({
      command: "npx",
      args: ["-y", "@example/weather@1.0.0"],
      env: { API_TOKEN: "${API_TOKEN}" },
    });
    expect(entry.variables).toContainEqual(expect.objectContaining({
      key: "API_TOKEN",
      secret: true,
      required: true,
    }));
  });

  it("omits optional unset environment variables", () => {
    const entry = importServerJson({
      name: "io.example/optional-env",
      packages: [{
        registryType: "npm",
        identifier: "@example/optional-env",
        environmentVariables: [{ name: "OPTIONAL_VALUE", isRequired: false }],
      }],
    });

    expect(entry.spec).not.toHaveProperty("env");
    expect(entry.variables).toBeUndefined();
  });

  it("imports Streamable HTTP variables from a Registry server wrapper", () => {
    const entry = importServerJson({
      server: {
        name: "io.example/remote",
        version: "1.0.0",
        remotes: [{
          type: "streamable-http",
          url: "https://{tenant}.example.com/mcp",
          variables: { tenant: { description: "Tenant", isRequired: false } },
        }],
      },
      _meta: {},
    });

    expect(entry.transport).toBe("http");
    expect(entry.spec).toMatchObject({ url: "https://${TENANT}.example.com/mcp" });
    expect(entry.variables).toContainEqual(expect.objectContaining({ key: "TENANT", required: true }));
  });

  it("skips unsupported package types when a supported remote is available", () => {
    const entry = importServerJson({
      name: "io.example/remote-fallback",
      packages: [{ registryType: "nuget", identifier: "Example.Server" }],
      remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
    });
    expect(entry.transport).toBe("http");
  });

  it("skips package entries declaring a non-stdio transport", () => {
    const entry = importServerJson({
      name: "io.example/remote-fallback",
      packages: [{ registryType: "npm", identifier: "@example/server", transport: { type: "custom" } }],
      remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
    });

    expect(entry.transport).toBe("http");
  });

  it("reports unsupported package-only manifests", () => {
    expect(() => importServerJson({
      name: "io.example/unsupported",
      packages: [{ registryType: "cargo", identifier: "example-server" }],
    })).toThrow(/no install method supported/i);
  });

  it("rejects legacy SSE-only remotes that the runtime cannot connect to", () => {
    expect(() => importServerJson({
      name: "io.example/sse-only",
      remotes: [{ type: "sse", url: "https://example.com/events" }],
    })).toThrow(/legacy SSE remotes are not supported/i);
  });
});
