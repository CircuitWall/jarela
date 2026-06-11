import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-allowed-sites-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { getDb } = await import("@/lib/db");
const {
  addAllowedSite,
  removeAllowedSite,
  setSsrfBypass,
  listAllowedSites,
  putCookies,
  isHostAllowed,
  getCookieHeaderForUrl,
} = await import("./allowed-sites");

function wipe(): void {
  getDb().exec("DELETE FROM allowed_sites");
}

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

beforeEach(() => { wipe(); });

describe("addAllowedSite", () => {
  it("normalizes hostname to lowercase and strips trailing dots", () => {
    const r = addAllowedSite({ hostname: "Jira.Example.COM." });
    if ("error" in r) throw new Error(r.error);
    expect(r.hostname).toBe("jira.example.com");
  });

  it("rejects malformed hostnames", () => {
    expect("error" in addAllowedSite({ hostname: "" })).toBe(true);
    expect("error" in addAllowedSite({ hostname: "  " })).toBe(true);
    expect("error" in addAllowedSite({ hostname: "with spaces.example.com" })).toBe(true);
    expect("error" in addAllowedSite({ hostname: "with/slash.example.com" })).toBe(true);
    expect("error" in addAllowedSite({ hostname: "http://example.com" })).toBe(true);
  });

  it("accepts IPv4 literals", () => {
    const r = addAllowedSite({ hostname: "10.0.0.1" });
    if ("error" in r) throw new Error(r.error);
    expect(r.hostname).toBe("10.0.0.1");
  });

  it("is idempotent — re-adding updates ssrf_bypass without duplicating", () => {
    addAllowedSite({ hostname: "example.com", ssrf_bypass: false });
    addAllowedSite({ hostname: "example.com", ssrf_bypass: true });
    const sites = listAllowedSites();
    expect(sites).toHaveLength(1);
    expect(sites[0].ssrf_bypass).toBe(true);
  });
});

describe("isHostAllowed (suffix matching)", () => {
  beforeEach(() => {
    addAllowedSite({ hostname: "example.com" });
  });

  it("matches exact host", () => {
    expect(isHostAllowed("example.com").allowed).toBe(true);
  });

  it("matches subdomains", () => {
    expect(isHostAllowed("foo.example.com").allowed).toBe(true);
    expect(isHostAllowed("a.b.c.example.com").allowed).toBe(true);
  });

  it("does not match parent or sibling domains", () => {
    expect(isHostAllowed("com").allowed).toBe(false);
    expect(isHostAllowed("notexample.com").allowed).toBe(false);
    expect(isHostAllowed("example.org").allowed).toBe(false);
  });

  it("prefers the most-specific entry when both parent and subdomain are listed", () => {
    addAllowedSite({ hostname: "jira.example.com", ssrf_bypass: true });
    const m = isHostAllowed("jira.example.com");
    expect(m.matchedHostname).toBe("jira.example.com");
    expect(m.ssrfBypass).toBe(true);
  });
});

describe("cookie storage and retrieval", () => {
  beforeEach(() => {
    addAllowedSite({ hostname: "example.com" });
  });

  it("returns null when no cookies are stored", () => {
    expect(getCookieHeaderForUrl("https://example.com/page")).toBeNull();
  });

  it("rejects writes for non-allowed hosts", () => {
    expect(putCookies("notallowed.com", [
      { name: "x", value: "1", domain: "notallowed.com", path: "/" },
    ])).toBe(false);
  });

  it("round-trips cookies through encryption", () => {
    putCookies("example.com", [
      { name: "sid", value: "abc123", domain: "example.com", path: "/" },
      { name: "lang", value: "en", domain: "example.com", path: "/" },
    ]);
    const header = getCookieHeaderForUrl("https://example.com/page");
    expect(header).toBe("sid=abc123; lang=en");
  });

  it("filters cookies by path", () => {
    putCookies("example.com", [
      { name: "global", value: "1", domain: "example.com", path: "/" },
      { name: "admin", value: "2", domain: "example.com", path: "/admin" },
    ]);
    expect(getCookieHeaderForUrl("https://example.com/")).toBe("global=1");
    expect(getCookieHeaderForUrl("https://example.com/admin")).toBe("global=1; admin=2");
    expect(getCookieHeaderForUrl("https://example.com/admin/users")).toBe("global=1; admin=2");
    expect(getCookieHeaderForUrl("https://example.com/administrator")).toBe("global=1");
  });

  it("filters Secure cookies on http URLs", () => {
    putCookies("example.com", [
      { name: "sec", value: "1", domain: "example.com", path: "/", secure: true },
      { name: "any", value: "1", domain: "example.com", path: "/", secure: false },
    ]);
    expect(getCookieHeaderForUrl("http://example.com/")).toBe("any=1");
    expect(getCookieHeaderForUrl("https://example.com/")).toBe("sec=1; any=1");
  });

  it("filters expired cookies", () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const future = Math.floor(Date.now() / 1000) + 3600;
    putCookies("example.com", [
      { name: "stale", value: "1", domain: "example.com", path: "/", expirationDate: past },
      { name: "fresh", value: "1", domain: "example.com", path: "/", expirationDate: future },
    ]);
    expect(getCookieHeaderForUrl("https://example.com/")).toBe("fresh=1");
  });

  it("attaches cookies for subdomain requests when entry is parent", () => {
    putCookies("example.com", [
      { name: "wide", value: "1", domain: ".example.com", path: "/" },
    ]);
    expect(getCookieHeaderForUrl("https://foo.example.com/")).toBe("wide=1");
  });

  it("returns null for hosts off the allow-list", () => {
    putCookies("example.com", [
      { name: "x", value: "1", domain: "example.com", path: "/" },
    ]);
    expect(getCookieHeaderForUrl("https://otherdomain.com/")).toBeNull();
  });

  it("bumps last_used_at on header read", () => {
    putCookies("example.com", [
      { name: "x", value: "1", domain: "example.com", path: "/" },
    ]);
    const before = listAllowedSites()[0].last_used_at;
    expect(before).toBeNull();
    getCookieHeaderForUrl("https://example.com/");
    const after = listAllowedSites()[0].last_used_at;
    expect(after).not.toBeNull();
  });
});

describe("setSsrfBypass / removeAllowedSite", () => {
  it("toggles ssrf_bypass on an existing entry", () => {
    addAllowedSite({ hostname: "example.com" });
    expect(setSsrfBypass("example.com", true)).toBe(true);
    expect(listAllowedSites()[0].ssrf_bypass).toBe(true);
  });

  it("returns false when toggling a missing host", () => {
    expect(setSsrfBypass("nope.example.com", true)).toBe(false);
  });

  it("remove cascades the cookie blob", () => {
    addAllowedSite({ hostname: "example.com" });
    putCookies("example.com", [
      { name: "x", value: "1", domain: "example.com", path: "/" },
    ]);
    expect(removeAllowedSite("example.com")).toBe(true);
    expect(listAllowedSites()).toHaveLength(0);
    addAllowedSite({ hostname: "example.com" });
    expect(getCookieHeaderForUrl("https://example.com/")).toBeNull();
  });
});

describe("listAllowedSites UI safety", () => {
  it("never exposes cookie blob in the listing", () => {
    addAllowedSite({ hostname: "example.com" });
    putCookies("example.com", [
      { name: "secret", value: "verysecret", domain: "example.com", path: "/" },
    ]);
    const status = listAllowedSites()[0];
    const json = JSON.stringify(status);
    expect(json).not.toContain("verysecret");
    expect(json).not.toContain("secret=");
    expect(status.has_cookies).toBe(true);
  });
});
