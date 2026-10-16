import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-proxy-config-"));
process.env.JARELA_DB_DIR = tmpRoot;

const store = await import("./proxy-config");
const { getDb } = await import("@/lib/db");
const { SECRET_MASK } = await import("./integrations");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n";

function storedPasswordColumn(): string | null {
  const row = getDb().prepare("SELECT password FROM proxy_config WHERE id = 1").get() as { password: string | null } | undefined;
  return row?.password ?? null;
}

describe("proxy-config store", () => {
  beforeEach(() => {
    getDb().exec("DELETE FROM proxy_config");
  });

  it("returns the default off status before anything is saved", () => {
    expect(store.getProxyConfigStatus()).toMatchObject({ mode: "off", scheme: "http", host: null, password: null });
    expect(store.getProxyConfigRaw()).toBeNull();
    expect(store.deleteProxyConfig()).toBe(false);
  });

  it("encrypts the password at rest, masks it in status and decrypts it for the dispatcher", () => {
    const saved = store.saveProxyConfig({ mode: "manual", host: "proxy.corp", port: 3128, username: "u", password: "p@ss:word" });
    expect(saved).toMatchObject({ mode: "manual", host: "proxy.corp", port: 3128, password: SECRET_MASK });
    expect(storedPasswordColumn()).not.toContain("p@ss:word");
    expect(store.getProxyConfigRaw()?.password).toBe("p@ss:word");
  });

  it("keeps the existing password when the UI echoes the mask back, without re-encrypting it", () => {
    store.saveProxyConfig({ mode: "manual", host: "proxy.corp", port: 3128, username: "u", password: "secret" });
    const before = storedPasswordColumn();
    store.saveProxyConfig({ mode: "manual", host: "proxy2.corp", port: 8080, username: "u", password: SECRET_MASK });
    expect(storedPasswordColumn()).toBe(before);
    expect(store.getProxyConfigRaw()).toMatchObject({ host: "proxy2.corp", port: 8080, password: "secret" });
  });

  it("never stores the mask itself as a password when none existed", () => {
    store.saveProxyConfig({ mode: "manual", host: "proxy.corp", port: 3128, password: SECRET_MASK });
    expect(store.getProxyConfigRaw()?.password).toBeNull();
    expect(store.getProxyConfigStatus().password).toBeNull();
  });

  it("clears the password when an empty string or null is sent", () => {
    store.saveProxyConfig({ mode: "manual", host: "proxy.corp", port: 3128, password: "secret" });
    store.saveProxyConfig({ mode: "manual", host: "proxy.corp", port: 3128, password: "" });
    expect(store.getProxyConfigRaw()?.password).toBeNull();
    store.saveProxyConfig({ mode: "manual", host: "proxy.corp", port: 3128, password: "secret" });
    store.saveProxyConfig({ mode: "manual", host: "proxy.corp", port: 3128, password: null });
    expect(store.getProxyConfigRaw()?.password).toBeNull();
  });

  it("trims host, username and no_proxy and stores blanks as null", () => {
    store.saveProxyConfig({ mode: "manual", host: "  proxy.corp  ", port: 3128, username: "   ", no_proxy: "  " });
    expect(store.getProxyConfigRaw()).toMatchObject({ host: "proxy.corp", username: null, no_proxy: null });
  });

  it.each([
    ["a URL with a scheme", "http://proxy.corp"],
    ["a host with a port", "proxy.corp:8080"],
    ["a hex-only host with a port", "dead.beef:3128"],
    ["a host with a path", "proxy.corp/pac"],
    ["a host with credentials", "user:pw@proxy.corp"],
    ["a host with spaces", "proxy corp"],
  ])("rejects %s in manual mode instead of building a broken proxy URL", (_label, host) => {
    const result = store.saveProxyConfig({ mode: "manual", host, port: 3128 });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/host/i);
    expect(store.getProxyConfigRaw()).toBeNull();
  });

  it.each([
    ["fd00::1", "fd00::1"],
    ["[fd00::1]", "fd00::1"],
    ["10.0.0.5", "10.0.0.5"],
    ["proxy-1.corp.example", "proxy-1.corp.example"],
  ])("accepts host %s and stores it as %s", (input, stored) => {
    const result = store.saveProxyConfig({ mode: "manual", host: input, port: 3128 });
    expect(result).not.toHaveProperty("error");
    expect(store.getProxyConfigRaw()?.host).toBe(stored);
  });

  it.each([0, -1, 65536, 3128.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects port %s", (port) => {
    expect(store.saveProxyConfig({ mode: "manual", host: "proxy.corp", port })).toHaveProperty("error");
  });

  it("requires host and port only in manual mode", () => {
    expect(store.saveProxyConfig({ mode: "manual", port: 3128 })).toHaveProperty("error");
    expect(store.saveProxyConfig({ mode: "manual", host: "proxy.corp" })).toHaveProperty("error");
    expect(store.saveProxyConfig({ mode: "system" })).toMatchObject({ mode: "system" });
    expect(store.saveProxyConfig({ mode: "off" })).toMatchObject({ mode: "off" });
  });

  it("rejects an invalid mode and a non-PEM CA bundle, and clears a blank bundle", () => {
    expect(store.saveProxyConfig({ mode: "auto" as never })).toHaveProperty("error");
    expect(store.saveProxyConfig({ mode: "off", ca_bundle: "not a cert" })).toHaveProperty("error");
    store.saveProxyConfig({ mode: "off", ca_bundle: PEM });
    expect(store.getProxyConfigRaw()?.ca_bundle).toBe(PEM);
    store.saveProxyConfig({ mode: "off", ca_bundle: "   " });
    expect(store.getProxyConfigRaw()?.ca_bundle).toBeNull();
  });

  it("normalises an unknown persisted scheme to http", () => {
    store.saveProxyConfig({ mode: "manual", host: "proxy.corp", port: 3128 });
    getDb().prepare("UPDATE proxy_config SET scheme = 'socks5' WHERE id = 1").run();
    expect(store.getProxyConfigRaw()).toMatchObject({ mode: "manual", scheme: "http" });
  });
});
