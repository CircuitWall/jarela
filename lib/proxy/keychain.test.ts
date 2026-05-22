import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { parseSecurityFindCertificate } from "./keychain";

const CERT_A = `-----BEGIN CERTIFICATE-----
MIIBszCCAVigAwIBAgIUFakeCertADoNotTrust00000000000wCgYIKoZIzj0EAwIw
LDEqMCgGA1UEAxMhVGVzdCBSb290IENlcnRpZmljYXRlIEF1dGhvcml0eSBBMB4X
DTI2MDEwMTAwMDAwMFoXDTM2MDEwMTAwMDAwMFowLDEqMCgGA1UEAxMhVGVzdCBS
b290IENlcnRpZmljYXRlIEF1dGhvcml0eSBBMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAE0000000000000000000000000000000000000000000000000000000A
-----END CERTIFICATE-----`;

const CERT_B = `-----BEGIN CERTIFICATE-----
MIIBszCCAVigAwIBAgIUFakeCertBDoNotTrust00000000000wCgYIKoZIzj0EAwIw
LDEqMCgGA1UEAxMhVGVzdCBSb290IENlcnRpZmljYXRlIEF1dGhvcml0eSBCMB4X
DTI2MDEwMTAwMDAwMFoXDTM2MDEwMTAwMDAwMFowLDEqMCgGA1UEAxMhVGVzdCBS
b290IENlcnRpZmljYXRlIEF1dGhvcml0eSBCMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAE0000000000000000000000000000000000000000000000000000000B
-----END CERTIFICATE-----`;

describe("parseSecurityFindCertificate", () => {
  it("extracts a single PEM block", () => {
    const out = parseSecurityFindCertificate(CERT_A);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("BEGIN CERTIFICATE");
    expect(out[0]).toContain("END CERTIFICATE");
  });

  it("extracts multiple PEM blocks separated by blank lines", () => {
    const out = parseSecurityFindCertificate(`${CERT_A}\n\n${CERT_B}\n`);
    expect(out).toHaveLength(2);
  });

  it("extracts multiple PEM blocks separated by junk text (real `security` output has labels between certs)", () => {
    const stdout = `${CERT_A}\nkeychain: "/Library/Keychains/System.keychain"\n${CERT_B}`;
    const out = parseSecurityFindCertificate(stdout);
    expect(out).toHaveLength(2);
  });

  it("dedupes identical certs", () => {
    const out = parseSecurityFindCertificate(`${CERT_A}\n${CERT_A}\n${CERT_B}`);
    expect(out).toHaveLength(2);
  });

  it("normalises CRLF line endings before deduping", () => {
    const crlf = CERT_A.replace(/\n/g, "\r\n");
    const out = parseSecurityFindCertificate(`${CERT_A}\n${crlf}`);
    // Same cert with different line endings should collapse to one entry.
    expect(out).toHaveLength(1);
  });

  it("returns empty array on input with no PEM blocks", () => {
    expect(parseSecurityFindCertificate("")).toEqual([]);
    expect(parseSecurityFindCertificate("nothing here")).toEqual([]);
    expect(parseSecurityFindCertificate("-----BEGIN CERTIFICATE-----\nincomplete")).toEqual([]);
  });

  it("preserves first-seen order across duplicates", () => {
    const out = parseSecurityFindCertificate(`${CERT_B}\n${CERT_A}\n${CERT_B}`);
    expect(out).toHaveLength(2);
    // CERT_B was first
    expect(out[0]).toContain("FakeCertB");
    expect(out[1]).toContain("FakeCertA");
  });
});

describe("extractSystemKeychainCAs platform guard", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("returns an error on non-darwin platforms", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    // Re-import so the early-return sees the patched platform.
    const { extractSystemKeychainCAs } = await import("./keychain");
    const r = extractSystemKeychainCAs();
    expect(r).toEqual({ error: expect.stringContaining("macOS-only") });
  });
});
