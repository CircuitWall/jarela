import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mocks must be declared before importing the module under test. Vitest
// hoists `vi.mock` calls to the top of the file regardless of position,
// but keeping them up here matches the literal evaluation order so the
// file reads predictably.

vi.mock("@/lib/stores/proxy-config", () => ({
  getProxyConfigRaw: vi.fn(),
}));

vi.mock("@/lib/proxy/keychain", () => ({
  extractSystemKeychainCAs: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(),
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    exec: vi.fn(),
  };
});

import { exec } from "node:child_process";
import { readFileSync } from "node:fs";
import { getProxyConfigRaw, type ProxyConfigRaw } from "@/lib/stores/proxy-config";
import { extractSystemKeychainCAs } from "@/lib/proxy/keychain";

const mockedGetProxyConfigRaw = vi.mocked(getProxyConfigRaw);
const mockedExtract = vi.mocked(extractSystemKeychainCAs);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExec = vi.mocked(exec);

const FAKE_PEM = "-----BEGIN CERTIFICATE-----\nfakebody\n-----END CERTIFICATE-----\n";

// promisify(exec) calls cb(err, { stdout, stderr }). Helper so each test
// can shape one call without re-implementing the cb dance.
function execReturns(stdout: string) {
  // @ts-expect-error — node child_process exec signature is overloaded
  // and the mock is loose; we only need the shape promisify expects.
  mockedExec.mockImplementation((_cmd, _opts, cb) => {
    if (typeof _opts === "function") cb = _opts;
    (cb as unknown as ((e: Error | null, v: { stdout: string; stderr: string }) => void) | undefined)?.(null, { stdout, stderr: "" });
  });
}

function execFails(message = "boom") {
  // @ts-expect-error — see above.
  mockedExec.mockImplementation((_cmd, _opts, cb) => {
    if (typeof _opts === "function") cb = _opts;
    (cb as unknown as ((e: Error | null, v: { stdout: string; stderr: string }) => void) | undefined)?.(new Error(message), { stdout: "", stderr: "" });
  });
}

describe("applyProxyConfigFromDb — system mode", () => {
  // Snapshot env so the module-load capture of HTTP_PROXY can't poison
  // tests, and restore between specs.
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;

  beforeEach(() => {
    // Strip any inherited proxy env so ENV_HAD_PROXY_AT_BOOT (computed
    // at module load) reflects "no env proxy". We re-import the module
    // inside each test so the snapshot is recomputed.
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.NO_PROXY;
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("extracts keychain bundle and detects scutil proxy, returning both", async () => {
    mockedGetProxyConfigRaw.mockReturnValue({
      mode: "system",
      scheme: "http",
      host: null,
      port: null,
      username: null,
      password: null,
      no_proxy: null,
      ca_bundle: null,
      updated_at: "2026-05-22T00:00:00.000Z",
    });
    mockedExtract.mockReturnValue({
      pemPath: "/tmp/system-ca.pem",
      certCount: 187,
      source: "macos-keychain",
      keychains: ["/Library/Keychains/System.keychain"],
    });
    mockedReadFileSync.mockReturnValue(FAKE_PEM);
    execReturns(
      [
        "<dictionary> {",
        "  HTTPSEnable : 1",
        "  HTTPSProxy : userproxy.example.com",
        "  HTTPSPort : 443",
        "}",
      ].join("\n"),
    );

    const { applyProxyConfigFromDb } = await import("./dispatcher");
    const r = await applyProxyConfigFromDb();

    expect(r.source).toBe("system");
    // redactAuth() runs the URL through `new URL().toString()`, which
    // canonicalises a trailing slash onto the path. Match that, not the
    // raw input.
    expect(r.proxyUrl).toBe("http://userproxy.example.com:443/");
    expect(r.caBundlePath).toBe("/tmp/system-ca.pem");
    expect(r.caBundleCertCount).toBe(187);
    expect(r.caBundleSource).toBe("macos-keychain");
    expect(r.note).toMatch(/187/);
    expect(mockedExtract).toHaveBeenCalledTimes(1);
  });

  it("applies extracted bundle to direct egress when scutil reports no HTTPS proxy (PAC / on-host agent case)", async () => {
    mockedGetProxyConfigRaw.mockReturnValue({
      mode: "system",
      scheme: "http",
      host: null,
      port: null,
      username: null,
      password: null,
      no_proxy: null,
      ca_bundle: null,
      updated_at: "2026-05-22T00:00:00.000Z",
    });
    mockedExtract.mockReturnValue({
      pemPath: "/tmp/system-ca.pem",
      certCount: 42,
      source: "macos-keychain",
      keychains: ["/Library/Keychains/System.keychain"],
    });
    mockedReadFileSync.mockReturnValue(FAKE_PEM);
    execReturns("<dictionary> {\n  HTTPSEnable : 0\n}");

    const { applyProxyConfigFromDb } = await import("./dispatcher");
    const r = await applyProxyConfigFromDb();

    expect(r.source).toBe("off");
    expect(r.proxyUrl).toBeNull();
    // Trust bundle still surfaces — direct egress can still face MITM.
    expect(r.caBundlePath).toBe("/tmp/system-ca.pem");
    expect(r.caBundleCertCount).toBe(42);
    // Note must mention the bundle was actually applied, not just discovered —
    // this is the regression that left users with UNABLE_TO_GET_ISSUER_CERT.
    expect(r.note).toMatch(/applied 42 keychain CAs/);
  });

  it("falls back to user-pasted ca_bundle when keychain extraction fails", async () => {
    mockedGetProxyConfigRaw.mockReturnValue({
      mode: "system",
      scheme: "http",
      host: null,
      port: null,
      username: null,
      password: null,
      no_proxy: null,
      ca_bundle: "-----BEGIN CERTIFICATE-----\nuserpaste\n-----END CERTIFICATE-----\n",
      updated_at: "2026-05-22T00:00:00.000Z",
    });
    mockedExtract.mockReturnValue({ error: "no certificates extracted" });
    execReturns(
      [
        "<dictionary> {",
        "  HTTPSEnable : 1",
        "  HTTPSProxy : userproxy.example.com",
        "  HTTPSPort : 443",
        "}",
      ].join("\n"),
    );

    const { applyProxyConfigFromDb } = await import("./dispatcher");
    const r = await applyProxyConfigFromDb();

    expect(r.source).toBe("system");
    expect(r.proxyUrl).toBe("http://userproxy.example.com:443/");
    // No keychain metadata — extraction failed.
    expect(r.caBundlePath).toBeUndefined();
    expect(r.caBundleCertCount).toBeUndefined();
    expect(r.caBundleSource).toBeUndefined();
  });

  it("returns off with macOS-only note on non-darwin even when cfg.mode is system", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mockedGetProxyConfigRaw.mockReturnValue({
      mode: "system",
      scheme: "http",
      host: null,
      port: null,
      username: null,
      password: null,
      no_proxy: null,
      ca_bundle: null,
      updated_at: "2026-05-22T00:00:00.000Z",
    });
    mockedExtract.mockReturnValue({ error: "system trust extraction is macOS-only in v1" });
    // detectSystemProxy returns null on non-darwin without invoking exec,
    // but stub anyway in case the guard moves.
    execFails("should not be called");

    const { applyProxyConfigFromDb } = await import("./dispatcher");
    const r = await applyProxyConfigFromDb();

    expect(r.source).toBe("off");
    expect(r.proxyUrl).toBeNull();
    expect(r.note).toMatch(/macOS-only/);
  });
});

describe("applyProxyConfigFromDb — env override", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("env-set proxy at boot wins over DB system mode", async () => {
    process.env.HTTPS_PROXY = "http://envproxy:3128";
    mockedGetProxyConfigRaw.mockReturnValue({
      mode: "system",
      scheme: "http",
      host: null,
      port: null,
      username: null,
      password: null,
      no_proxy: null,
      ca_bundle: null,
      updated_at: "2026-05-22T00:00:00.000Z",
    });

    const { applyProxyConfigFromDb, envProxyWasSetAtBoot } = await import("./dispatcher");
    expect(envProxyWasSetAtBoot()).toBe(true);
    const r = await applyProxyConfigFromDb();
    expect(r.source).toBe("env");
    // Keychain not consulted when env wins.
    expect(mockedExtract).not.toHaveBeenCalled();
  });
});

describe("applyProxyConfigFromDb — manual mode", () => {
  const originalEnv = { ...process.env };

  function manual(overrides: Partial<ProxyConfigRaw> = {}): ProxyConfigRaw {
    return {
      mode: "manual",
      scheme: "http",
      host: "proxy.corp",
      port: 3128,
      username: null,
      password: null,
      no_proxy: null,
      ca_bundle: null,
      updated_at: "2026-05-22T00:00:00.000Z",
      ...overrides,
    };
  }

  beforeEach(() => {
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]) delete process.env[key];
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    mockedGetProxyConfigRaw.mockReturnValue(null);
    const { applyProxyConfigFromDb } = await import("./dispatcher");
    await applyProxyConfigFromDb();
    process.env = { ...originalEnv };
  });

  it("percent-encodes credentials in the proxy URL and redacts the password in the result", async () => {
    mockedGetProxyConfigRaw.mockReturnValue(manual({ username: "dom\\user", password: "p@ss:w/rd" }));
    const { applyProxyConfigFromDb } = await import("./dispatcher");
    const r = await applyProxyConfigFromDb();
    expect(r.source).toBe("manual");
    expect(process.env.HTTPS_PROXY).toBe("http://dom%5Cuser:p%40ss%3Aw%2Frd@proxy.corp:3128");
    expect(r.proxyUrl).toBe("http://dom%5Cuser:***@proxy.corp:3128/");
    expect(r.proxyUrl).not.toContain("p%40ss");
  });

  it("brackets an IPv6 proxy host so the URL is parseable", async () => {
    mockedGetProxyConfigRaw.mockReturnValue(manual({ host: "fd00::1" }));
    const { applyProxyConfigFromDb } = await import("./dispatcher");
    const r = await applyProxyConfigFromDb();
    expect(process.env.HTTPS_PROXY).toBe("http://[fd00::1]:3128");
    expect(r.proxyUrl).toBe("http://[fd00::1]:3128/");
  });

  it("always bypasses loopback, merged with the user's no_proxy list", async () => {
    mockedGetProxyConfigRaw.mockReturnValue(manual({ no_proxy: " corp.internal, .svc " }));
    const { applyProxyConfigFromDb } = await import("./dispatcher");
    await applyProxyConfigFromDb();
    const entries = (process.env.NO_PROXY ?? "").split(",");
    expect(entries).toEqual(expect.arrayContaining(["corp.internal", ".svc", "localhost", "127.0.0.1", "::1"]));
    expect(new Set(entries).size).toBe(entries.length);
  });

  it("still reaches a local server (e.g. Ollama) directly when the proxy is unreachable", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => res.end("local-ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      // Port 9 (discard) on loopback refuses connections, so any request
      // routed through this "proxy" fails.
      mockedGetProxyConfigRaw.mockReturnValue(manual({ host: "127.0.0.1", port: 9 }));
      const { applyProxyConfigFromDb } = await import("./dispatcher");
      await applyProxyConfigFromDb();
      for (const host of ["127.0.0.1", "localhost"]) {
        const res = await fetch(`http://${host}:${port}/`);
        expect(await res.text()).toBe("local-ok");
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps loopback direct even when a lowercase no_proxy is inherited", async () => {
    // undici reads lowercase no_proxy before NO_PROXY.
    process.env.no_proxy = "corp.internal";
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => res.end("local-ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      mockedGetProxyConfigRaw.mockReturnValue(manual({ host: "127.0.0.1", port: 9 }));
      const { applyProxyConfigFromDb } = await import("./dispatcher");
      await applyProxyConfigFromDb();
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe("local-ok");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reverts to no proxy when host or port is missing", async () => {
    mockedGetProxyConfigRaw.mockReturnValue(manual({ port: null }));
    const { applyProxyConfigFromDb } = await import("./dispatcher");
    const r = await applyProxyConfigFromDb();
    expect(r.source).toBe("off");
    expect(r.note).toMatch(/missing host\/port/);
    expect(process.env.HTTPS_PROXY).toBeUndefined();
  });

  it("clears the proxy env when switched back to off", async () => {
    mockedGetProxyConfigRaw.mockReturnValue(manual());
    const { applyProxyConfigFromDb } = await import("./dispatcher");
    await applyProxyConfigFromDb();
    expect(process.env.HTTPS_PROXY).toBeDefined();
    mockedGetProxyConfigRaw.mockReturnValue({ ...manual(), mode: "off" });
    const r = await applyProxyConfigFromDb();
    expect(r.source).toBe("off");
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(process.env.NO_PROXY).toBeUndefined();
  });
});