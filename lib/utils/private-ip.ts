// SSRF guard: classify an address (or hostname) as "private" — i.e. one
// that an LLM-driven agent should never be allowed to reach with a
// server-side fetch driven by attacker-controlled input. The bar is set
// by what the access middleware (lib/auth/access.ts) treats as
// privileged: anything that resolves to loopback hits the API without
// authentication, and link-local / cloud-metadata / RFC1918 ranges
// reach the host's LAN or cloud provider's introspection surface.
//
// Used by `web_fetch` and other agent-controlled URL fetchers to block
// the canonical SSRF / metadata-service paths:
//   - http://127.0.0.1:4312/api/v1/... → self-call into our own admin API
//   - http://169.254.169.254/...       → AWS/GCE/Azure metadata
//   - http://10.x / 192.168.x / etc.   → LAN router / printer admin
//
// Operators with a legitimate need (e.g. fetching from an internal docs
// server) can opt back in with `JARELA_ALLOW_PRIVATE_FETCH=1`.

import { promises as dns } from "node:dns";
import { getConfig } from "@/lib/env/config";
import net from "node:net";

export type PrivateClassification =
  | "public"
  | "loopback"
  | "private"
  | "link-local"
  | "unspecified"
  | "broadcast"
  | "reserved";

function ipv4InCidr(addr: number, prefix: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (addr & mask) === (prefix & mask);
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function classifyIPv4(ip: string): PrivateClassification {
  const n = ipv4ToNumber(ip);
  if (n === null) return "reserved";
  // 0.0.0.0/8 — "this network"
  if (ipv4InCidr(n, ipv4ToNumber("0.0.0.0")!, 8)) return "unspecified";
  // 127.0.0.0/8 — loopback
  if (ipv4InCidr(n, ipv4ToNumber("127.0.0.0")!, 8)) return "loopback";
  // 10.0.0.0/8
  if (ipv4InCidr(n, ipv4ToNumber("10.0.0.0")!, 8)) return "private";
  // 172.16.0.0/12
  if (ipv4InCidr(n, ipv4ToNumber("172.16.0.0")!, 12)) return "private";
  // 192.168.0.0/16
  if (ipv4InCidr(n, ipv4ToNumber("192.168.0.0")!, 16)) return "private";
  // 169.254.0.0/16 — link-local (incl. cloud metadata at 169.254.169.254)
  if (ipv4InCidr(n, ipv4ToNumber("169.254.0.0")!, 16)) return "link-local";
  // 100.64.0.0/10 — CGNAT / Tailscale carrier-grade NAT range. Treat as
  // private: anything reachable here is a tailnet peer, not a public URL.
  if (ipv4InCidr(n, ipv4ToNumber("100.64.0.0")!, 10)) return "private";
  // 224.0.0.0/4 — multicast; 240.0.0.0/4 — reserved; 255.255.255.255 — broadcast
  if (ipv4InCidr(n, ipv4ToNumber("224.0.0.0")!, 4)) return "reserved";
  if (ipv4InCidr(n, ipv4ToNumber("240.0.0.0")!, 4)) return "reserved";
  return "public";
}

function classifyIPv6(ip: string): PrivateClassification {
  // Normalise: lower-case, drop zone id (fe80::1%eth0).
  const bare = ip.toLowerCase().split("%")[0];
  if (bare === "::" || bare === "::0") return "unspecified";
  if (bare === "::1") return "loopback";
  // IPv4-mapped (::ffff:a.b.c.d) — classify the embedded v4.
  if (bare.startsWith("::ffff:")) {
    const v4 = bare.slice(7);
    if (net.isIPv4(v4)) return classifyIPv4(v4);
  }
  // fe80::/10 — link-local
  if (/^fe[89ab][0-9a-f]?:/.test(bare)) return "link-local";
  // fc00::/7 — unique local addresses
  if (/^f[cd][0-9a-f]{0,2}:/.test(bare)) return "private";
  // ff00::/8 — multicast
  if (bare.startsWith("ff")) return "reserved";
  return "public";
}

export function classifyAddress(ip: string): PrivateClassification {
  if (net.isIPv4(ip)) return classifyIPv4(ip);
  if (net.isIPv6(ip)) return classifyIPv6(ip);
  return "reserved";
}

export function isPrivateAddress(ip: string): boolean {
  const cls = classifyAddress(ip);
  return cls !== "public";
}

export interface UrlCheckResult {
  allowed: boolean;
  reason?: PrivateClassification | "invalid-url" | "unsupported-scheme" | "resolve-failed";
  resolved?: string[];
}

/**
 * Pre-flight check for a server-side fetch driven by agent input.
 *
 * Returns `{ allowed: true }` when every IP the URL's hostname resolves
 * to is publicly routable. If `JARELA_ALLOW_PRIVATE_FETCH=1` the result
 * is always `{ allowed: true }` (operator opt-out).
 *
 * Hostnames that fail to resolve are treated as **rejected** — better to
 * refuse than to hand the question off to undici and re-resolve at
 * connect time, when we have no way to inspect the answer.
 */
export async function checkPublicUrl(rawUrl: string): Promise<UrlCheckResult> {
  if (getConfig().allowPrivateFetch) {
    return { allowed: true };
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "invalid-url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, reason: "unsupported-scheme" };
  }
  // Strip [] from IPv6 literals so net.isIP / dns.lookup work.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    const cls = classifyAddress(host);
    return cls === "public" ? { allowed: true, resolved: [host] } : { allowed: false, reason: cls, resolved: [host] };
  }
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    return { allowed: false, reason: "resolve-failed" };
  }
  const resolved = addrs.map((a) => a.address);
  for (const addr of resolved) {
    const cls = classifyAddress(addr);
    if (cls !== "public") return { allowed: false, reason: cls, resolved };
  }
  return { allowed: true, resolved };
}
