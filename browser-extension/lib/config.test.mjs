import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONFIG,
  STORAGE_KEY,
  parseConfig,
  isValidHost,
  isValidPort,
  isValidScheme,
  buildBase,
  buildOrigins,
  buildOriginPatterns,
  matchesLaunchUrl,
  healthUrl,
  captureUrl,
  extensionRefineUrl,
  extensionFillUrl,
  extensionTurnUrl,
  extensionAgentsUrl,
  appUrl,
} from "./config.mjs";

describe("config constants", () => {
  it("exposes a stable storage key", () => {
    expect(STORAGE_KEY).toBe("jarelaConfig");
  });

  it("ships sensible defaults", () => {
    expect(DEFAULT_CONFIG).toEqual({
      scheme: "http",
      host: "127.0.0.1",
      port: 4312,
      preferPwa: true,
      autoOpen: false,
    });
  });

  it("freezes the defaults so callers can't mutate them", () => {
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
  });
});

describe("isValidScheme", () => {
  it("accepts http and https", () => {
    expect(isValidScheme("http")).toBe(true);
    expect(isValidScheme("https")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isValidScheme("ftp")).toBe(false);
    expect(isValidScheme("HTTP")).toBe(false);
    expect(isValidScheme("")).toBe(false);
    expect(isValidScheme(undefined)).toBe(false);
    expect(isValidScheme(null)).toBe(false);
  });
});

describe("isValidPort", () => {
  it("accepts integers in 1..65535", () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(80)).toBe(true);
    expect(isValidPort(4312)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
    expect(isValidPort("4312")).toBe(true); // coerced
  });

  it("rejects out-of-range, non-integer, and garbage values", () => {
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(-1)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort(4312.5)).toBe(false);
    expect(isValidPort("abc")).toBe(false);
    expect(isValidPort("")).toBe(false);
    expect(isValidPort(null)).toBe(false);
    expect(isValidPort(undefined)).toBe(false);
  });
});

describe("isValidHost", () => {
  it("accepts loopback names and IPv4 literals", () => {
    expect(isValidHost("localhost")).toBe(true);
    expect(isValidHost("127.0.0.1")).toBe(true);
    expect(isValidHost("0.0.0.0")).toBe(true);
    expect(isValidHost("192.168.1.42")).toBe(true);
  });

  it("accepts multi-label hostnames including Tailscale MagicDNS", () => {
    expect(isValidHost("my-laptop.tailnet-ab12.ts.net")).toBe(true);
    expect(isValidHost("jarela.local")).toBe(true);
    expect(isValidHost("a.b.c.d.example.com")).toBe(true);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(isValidHost("  localhost  ")).toBe(true);
  });

  it("rejects URLs, paths, ports, and other punctuation", () => {
    expect(isValidHost("http://localhost")).toBe(false);
    expect(isValidHost("localhost:4312")).toBe(false);
    expect(isValidHost("localhost/api")).toBe(false);
    expect(isValidHost("foo bar")).toBe(false);
    expect(isValidHost("a?b")).toBe(false);
    expect(isValidHost("a#b")).toBe(false);
  });

  it("rejects invalid IPv4 octets", () => {
    expect(isValidHost("999.0.0.1")).toBe(false);
    expect(isValidHost("256.1.1.1")).toBe(false);
  });

  it("rejects empty / leading-dash labels and too-long input", () => {
    expect(isValidHost("")).toBe(false);
    expect(isValidHost(".")).toBe(false);
    expect(isValidHost("-foo.com")).toBe(false);
    expect(isValidHost("foo-.com")).toBe(false);
    expect(isValidHost("a".repeat(254))).toBe(false);
  });

  it("rejects non-string inputs", () => {
    expect(isValidHost(undefined)).toBe(false);
    expect(isValidHost(null)).toBe(false);
    expect(isValidHost(42)).toBe(false);
    expect(isValidHost({})).toBe(false);
  });
});

describe("parseConfig", () => {
  it("returns defaults for null / undefined / non-object input", () => {
    expect(parseConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(parseConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(parseConfig("oops")).toEqual(DEFAULT_CONFIG);
    expect(parseConfig(42)).toEqual(DEFAULT_CONFIG);
  });

  it("returns defaults for empty objects", () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it("accepts a fully valid object", () => {
    expect(parseConfig({ scheme: "https", host: "jarela.local", port: 8443 })).toEqual({
      ...DEFAULT_CONFIG,
      scheme: "https",
      host: "jarela.local",
      port: 8443,
    });
  });

  it("falls back field-by-field for partial / invalid inputs", () => {
    expect(parseConfig({ scheme: "ftp", host: "localhost", port: 5000 })).toMatchObject({
      scheme: "http",
      host: "localhost",
      port: 5000,
    });
    expect(parseConfig({ scheme: "https", host: "bad host", port: 5000 })).toMatchObject({
      scheme: "https",
      host: DEFAULT_CONFIG.host,
      port: 5000,
    });
    expect(parseConfig({ scheme: "https", host: "localhost", port: 70000 })).toMatchObject({
      scheme: "https",
      host: "localhost",
      port: DEFAULT_CONFIG.port,
    });
  });

  it("coerces a numeric-string port", () => {
    expect(parseConfig({ port: "1234" }).port).toBe(1234);
  });

  it("trims the host", () => {
    expect(parseConfig({ host: "  jarela.local  " }).host).toBe("jarela.local");
  });

  it("preserves boolean toggles when present", () => {
    const cfg = parseConfig({ preferPwa: false, autoOpen: true });
    expect(cfg.preferPwa).toBe(false);
    expect(cfg.autoOpen).toBe(true);
  });

  it("ignores non-boolean toggle values and keeps defaults", () => {
    const cfg = parseConfig({ preferPwa: "yes", autoOpen: 1 });
    expect(cfg.preferPwa).toBe(DEFAULT_CONFIG.preferPwa);
    expect(cfg.autoOpen).toBe(DEFAULT_CONFIG.autoOpen);
  });
});

describe("buildBase", () => {
  it("renders the default config", () => {
    expect(buildBase(DEFAULT_CONFIG)).toBe("http://127.0.0.1:4312");
  });

  it("renders custom configs", () => {
    expect(buildBase({ scheme: "https", host: "jarela.local", port: 8443 }))
      .toBe("https://jarela.local:8443");
  });

  it("omits the port when it matches the scheme default", () => {
    expect(buildBase({ scheme: "http", host: "example.com", port: 80 }))
      .toBe("http://example.com");
    expect(buildBase({ scheme: "https", host: "example.com", port: 443 }))
      .toBe("https://example.com");
  });

  it("normalizes garbage input through parseConfig", () => {
    expect(buildBase({ scheme: "gopher", host: "x y", port: -1 }))
      .toBe(`${DEFAULT_CONFIG.scheme}://${DEFAULT_CONFIG.host}:${DEFAULT_CONFIG.port}`);
  });
});

describe("healthUrl / captureUrl / appUrl", () => {
  it("derive the expected paths from the base", () => {
    const cfg = { scheme: "http", host: "127.0.0.1", port: 4312 };
    expect(healthUrl(cfg)).toBe("http://127.0.0.1:4312/api/v1/health");
    expect(captureUrl(cfg)).toBe("http://127.0.0.1:4312/api/v1/page-capture");
    expect(extensionRefineUrl(cfg)).toBe("http://127.0.0.1:4312/api/v1/extension/refine");
    expect(extensionFillUrl(cfg)).toBe("http://127.0.0.1:4312/api/v1/extension/fill");
    expect(extensionTurnUrl(cfg)).toBe("http://127.0.0.1:4312/api/v1/extension/turn");
    expect(extensionAgentsUrl(cfg)).toBe("http://127.0.0.1:4312/api/v1/extension/agents");
    expect(appUrl(cfg)).toBe("http://127.0.0.1:4312/");
  });
});

describe("buildOriginPatterns", () => {
  it("expands 127.0.0.1 to include localhost", () => {
    expect(buildOriginPatterns({ scheme: "http", host: "127.0.0.1", port: 4312 })).toEqual([
      "http://127.0.0.1:4312/*",
      "http://localhost:4312/*",
    ]);
  });

  it("expands localhost to include 127.0.0.1", () => {
    expect(buildOriginPatterns({ scheme: "http", host: "localhost", port: 4312 })).toEqual([
      "http://localhost:4312/*",
      "http://127.0.0.1:4312/*",
    ]);
  });

  it("returns a single pattern for non-loopback hosts", () => {
    expect(buildOriginPatterns({ scheme: "https", host: "jarela.local", port: 8443 }))
      .toEqual(["https://jarela.local:8443/*"]);
  });

  it("omits the port when it matches the scheme default", () => {
    expect(buildOriginPatterns({ scheme: "https", host: "jarela.local", port: 443 }))
      .toEqual(["https://jarela.local/*"]);
  });

  it("parses invalid input before building", () => {
    expect(buildOriginPatterns({ scheme: "bogus", host: "bad host", port: 0 }))
      .toEqual([
        `${DEFAULT_CONFIG.scheme}://${DEFAULT_CONFIG.host}:${DEFAULT_CONFIG.port}/*`,
        `${DEFAULT_CONFIG.scheme}://localhost:${DEFAULT_CONFIG.port}/*`,
      ]);
  });
});

describe("buildOrigins", () => {
  it("returns plain origins (no /*) for the configured pair", () => {
    expect(buildOrigins({ scheme: "http", host: "127.0.0.1", port: 4312 })).toEqual([
      "http://127.0.0.1:4312",
      "http://localhost:4312",
    ]);
  });

  it("matches buildOriginPatterns one-to-one minus the suffix", () => {
    const cfg = { scheme: "https", host: "jarela.local", port: 8443 };
    const origins = buildOrigins(cfg);
    const patterns = buildOriginPatterns(cfg);
    expect(patterns).toEqual(origins.map((o) => `${o}/*`));
  });
});

describe("matchesLaunchUrl", () => {
  const cfg = { scheme: "http", host: "127.0.0.1", port: 4312 };

  it("matches the exact configured origin", () => {
    expect(matchesLaunchUrl(cfg, "http://127.0.0.1:4312/")).toBe(true);
  });

  it("matches the loopback twin (127.0.0.1 ⇄ localhost)", () => {
    expect(matchesLaunchUrl(cfg, "http://localhost:4312/")).toBe(true);
    expect(matchesLaunchUrl({ ...cfg, host: "localhost" }, "http://127.0.0.1:4312/")).toBe(true);
  });

  it("ignores path, query, and fragment when matching", () => {
    expect(matchesLaunchUrl(cfg, "http://127.0.0.1:4312/chat?item=abc#m1")).toBe(true);
  });

  it("rejects mismatched scheme, host, or port", () => {
    expect(matchesLaunchUrl(cfg, "https://127.0.0.1:4312/")).toBe(false);
    expect(matchesLaunchUrl(cfg, "http://example.com:4312/")).toBe(false);
    expect(matchesLaunchUrl(cfg, "http://127.0.0.1:9999/")).toBe(false);
  });

  it("does not cross loopback equivalence for non-loopback configs", () => {
    expect(matchesLaunchUrl({ scheme: "http", host: "example.com", port: 80 }, "http://localhost/"))
      .toBe(false);
  });

  it("returns false for non-URL inputs", () => {
    expect(matchesLaunchUrl(cfg, "")).toBe(false);
    expect(matchesLaunchUrl(cfg, "not a url")).toBe(false);
    expect(matchesLaunchUrl(cfg, null)).toBe(false);
    expect(matchesLaunchUrl(cfg, undefined)).toBe(false);
    expect(matchesLaunchUrl(cfg, 42)).toBe(false);
  });

  it("handles scheme-default ports symmetrically", () => {
    // Configured without explicit port → builds origin without :80; a
    // launch URL that includes the default port should still match.
    const httpDefault = { scheme: "http", host: "example.com", port: 80 };
    expect(matchesLaunchUrl(httpDefault, "http://example.com/")).toBe(true);
    expect(matchesLaunchUrl(httpDefault, "http://example.com:80/")).toBe(true);
  });
});
