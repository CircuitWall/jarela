// In-process log capture.
//
// Patches the four `console.{log,info,warn,error}` methods so every line
// written to stdout/stderr is also pushed onto an in-memory ring buffer
// and broadcast to subscribers (the live SSE endpoint). The original
// stdout/stderr write is preserved verbatim — operators tailing the
// terminal see exactly the same output as before; the panel is purely
// additive.
//
// Bounded: ring caps at 2000 entries (~150 KB at typical line size) so a
// runaway log spew doesn't grow memory unbounded. Late subscribers see
// the most recent slice + everything after they connect.
//
// See ADR-0058.
//
// SECURITY NOTE: log lines often contain provider error bodies that
// happen to include credential material. Before storing or broadcasting
// we run each line through a redaction pass that replaces obvious
// `Authorization: Bearer …` / `api[_-]?key=…` / `token=…` patterns with
// `[redacted]`. This is best-effort; the underlying terminal output is
// unchanged (operators retain full fidelity for debugging on a trusted
// machine). The SSE endpoint is loopback-gated by the same auth rules
// as the rest of the API.

import { getConfig } from "@/lib/env/config";

export type LogLevel = "log" | "info" | "warn" | "error";

// "log" is treated as info-tier when filtering — Node's console.log writes
// to stdout, same severity as console.info.
const LEVEL_RANK: Record<LogLevel, number> = { log: 1, info: 1, warn: 2, error: 3 };
const CONFIG_LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 } as const;

export interface LogEntry {
  /** Monotonic per-process sequence; lets the SSE consumer dedupe across reconnects. */
  seq: number;
  ts: number;
  level: LogLevel;
  text: string;
}

type Subscriber = (entry: LogEntry) => void;

// JARELA_LOGS_RING_SIZE / JARELA_LOG_LEVEL override these. Read at first
// pushEntry, then memoised — the ring grows up to this cap and changes
// require restart (the splice() math closes over the cap value).
let _ringCap: number | null = null;
function ringCapacity(): number {
  if (_ringCap === null) _ringCap = getConfig().logsRingSize;
  return _ringCap;
}
function passesLogLevel(level: LogLevel): boolean {
  const min = CONFIG_LEVEL_RANK[getConfig().logLevel];
  return LEVEL_RANK[level] >= min;
}

const ring: LogEntry[] = [];
const subscribers = new Set<Subscriber>();
let nextSeq = 1;

const PATCH_MARK: unique symbol = Symbol.for("@jarela/console-patched");
type PatchedConsole = Console & { [PATCH_MARK]?: true };

const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  // Authorization / Proxy-Authorization header values.
  [/(authorization\s*[:=]\s*(?:bearer|basic)\s+)\S+/gi, "$1[redacted]"],
  // api_key / apikey / api-key in url query strings or JSON-ish text.
  [/(api[_-]?key["'\s:=]+)([A-Za-z0-9._-]{8,})/gi, "$1[redacted]"],
  // OpenAI / Anthropic / GitHub style tokens. Conservative — don't redact
  // tokens shorter than 16 chars (false-positive on agent IDs etc.).
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted-key]"],
  [/\bghp_[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]"],
  [/\bgho_[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]"],
  // Atlassian-style JWT-ish values in URL.
  [/(token\s*[:=]\s*)[A-Za-z0-9._-]{20,}/g, "$1[redacted]"],
];

function redact(line: string): string {
  let out = line;
  for (const [re, replacement] of REDACTION_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

function pushEntry(level: LogLevel, args: unknown[]): void {
  // Filter by configured level — terminal output is never filtered (the
  // patched console wrapper invoked the original BEFORE this), so this only
  // gates what lands in the in-app Logs panel + SSE feed.
  if (!passesLogLevel(level)) return;
  // Match Node's util.format-ish behaviour: stringify each arg and join with
  // spaces. Errors flatten to .stack when present.
  const text = redact(
    args
      .map((a) => {
        if (a instanceof Error) return a.stack ?? a.message;
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" "),
  );
  const entry: LogEntry = {
    seq: nextSeq,
    ts: Date.now(),
    level,
    text,
  };
  nextSeq += 1;
  ring.push(entry);
  const cap = ringCapacity();
  if (ring.length > cap) {
    ring.splice(0, ring.length - cap);
  }
  for (const sub of subscribers) {
    try { sub(entry); } catch { /* subscriber errored — ignore */ }
  }
}

/**
 * Patch console.{log,info,warn,error} once. Idempotent via a global
 * Symbol so dev HMR / multiple imports never double-patch.
 *
 * The original methods are kept verbatim — patched versions invoke the
 * originals first (so stdout/stderr output is unchanged), THEN push to
 * the ring + subscribers. Throws inside the ring path are swallowed so
 * a logging bug can't cascade into a console crash.
 */
export function installConsolePatch(): void {
  const c = console as PatchedConsole;
  if (c[PATCH_MARK]) return;

  const levels: LogLevel[] = ["log", "info", "warn", "error"];
  for (const level of levels) {
    const original = c[level].bind(console);
    c[level] = (...args: unknown[]) => {
      original(...args);
      try { pushEntry(level, args); } catch { /* logging bug — drop it */ }
    };
  }
  c[PATCH_MARK] = true;
}

/**
 * Subscribe to live log entries. Returns an unsubscribe function. SSE
 * route uses this to forward each new line to the connected client.
 *
 * Note: subscribers do NOT receive the historical ring — call
 * `recentEntries()` first to replay backlog, then subscribe for new lines.
 */
export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

/** Most recent N entries (most-recent-first ordering optional via reverse). */
export function recentEntries(limit?: number): LogEntry[] {
  if (!limit || limit >= ring.length) return ring.slice();
  return ring.slice(-limit);
}

/** Test-only: clear ring + subscriber set + reset seq + ring-cap memo. */
export function _resetLogSink(): void {
  ring.length = 0;
  subscribers.clear();
  nextSeq = 1;
  _ringCap = null;
}
