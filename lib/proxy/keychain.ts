// macOS keychain → PEM bundle export (ADR-0020).
//
// Macs with corporate roots in the keychain receive their root CAs (including the MITM root
// the egress proxy uses to re-sign outbound TLS) via MDM, which lands them
// in the System and Login keychains. We extract those certs to a single
// PEM file under the Jarela data dir, then point both undici's
// `requestTls.ca` (live) and the launchd plist's `NODE_EXTRA_CA_CERTS`
// (next restart) at it. End result: one source of truth (the OS), one
// destination (~/.jarela/system-ca.pem), zero manual paste.
//
// Sibling to `parseScutilProxy()` in dispatcher.ts — both turn an OS-level
// settings surface into something the dispatcher can consume.

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDataDir } from "@/lib/db/data-dir";

export interface KeychainExtractResult {
  pemPath: string;        // absolute path to the written bundle
  certCount: number;      // unique BEGIN CERTIFICATE blocks
  source: "macos-keychain";
  keychains: string[];    // which keychains contributed
}

const KEYCHAINS_TO_TRY = [
  "/Library/Keychains/System.keychain",
  "/System/Library/Keychains/SystemRootCertificates.keychain",
  // login.keychain-db lives under each user's home; resolved at runtime.
];

const PEM_BLOCK_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

// Exported for unit testing — the bare parser side, no fs / spawn.
// Returns deduped PEM blocks in first-seen order so callers can attribute
// "this cert came from system" vs "from login".
export function parseSecurityFindCertificate(stdout: string): string[] {
  const seen = new Set<string>();
  const blocks: string[] = [];
  const matches = stdout.match(PEM_BLOCK_RE) ?? [];
  for (const raw of matches) {
    // Normalise line endings so a CR-different copy of the same cert
    // doesn't slip past the dedupe.
    const normalised = raw.replace(/\r\n/g, "\n").trim();
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    blocks.push(normalised);
  }
  return blocks;
}

// Extract all certificates from the user's macOS trust stores into a
// single PEM bundle at <dataDir>/system-ca.pem. Returns the path + count.
//
// On non-darwin platforms returns { error } — callers should treat this
// as "no system trust available, proceed without an injected bundle".
export function extractSystemKeychainCAs(): KeychainExtractResult | { error: string } {
  if (process.platform !== "darwin") {
    return { error: "system trust extraction is macOS-only in v1" };
  }

  const candidates = [...KEYCHAINS_TO_TRY, join(homedir(), "Library/Keychains/login.keychain-db")];
  const used: string[] = [];
  const allPem: string[] = [];

  for (const kc of candidates) {
    if (!existsSync(kc)) continue;
    try {
      // -a = all matches, -p = output PEM. The path positional arg
      // restricts the search to this keychain. Fixed argv (no shell)
      // — safe even though no part of this is user-controlled.
      const out = execFileSync(
        "/usr/bin/security",
        ["find-certificate", "-a", "-p", kc],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      const blocks = parseSecurityFindCertificate(out);
      if (blocks.length > 0) {
        used.push(kc);
        allPem.push(...blocks);
      }
    } catch (err) {
      // Empty keychain or permission refusal — skip and continue.
      // We still want partial extraction (system but not login, etc.)
      // to succeed.
      console.warn(`[jarela/keychain] could not read ${kc}: ${(err as Error).message}`);
    }
  }

  // Dedupe across keychains: the same root commonly appears in System
  // and SystemRootCertificates.
  const deduped = parseSecurityFindCertificate(allPem.join("\n"));

  if (deduped.length === 0) {
    return { error: "no certificates extracted from any keychain (security find-certificate returned empty)" };
  }

  const pemPath = join(getDataDir(), "system-ca.pem");
  const body =
    `# Jarela system trust bundle — generated from macOS keychains.\n` +
    `# Source keychains: ${used.join(", ")}\n` +
    `# ${deduped.length} unique certificates. Regenerate via the Proxy panel\n` +
    `# "Refresh trust store" button, or by re-running 'jarela install-service'.\n\n` +
    deduped.join("\n") +
    "\n";
  writeFileSync(pemPath, body, "utf8");
  // Trust bundle is not secret but is user-scoped state; 0600 keeps it
  // tidy alongside the SQLite file's permissions.
  try { chmodSync(pemPath, 0o600); } catch { /* best-effort */ }

  return {
    pemPath,
    certCount: deduped.length,
    source: "macos-keychain",
    keychains: used,
  };
}
