import { getDb } from "@/lib/db";
import type { BrowserCommandPayload } from "@/lib/api/browser-control";

export type BrowserCommandStatus = "queued" | "running" | "succeeded" | "failed";

export interface BrowserCommandLogEntry {
  cmd_id: string;
  type: string;
  status: BrowserCommandStatus;
  host: string | null;
  tab_id: number | null;
  summary: string;
  retryable: boolean;
  retry_payload: BrowserCommandPayload | null;
  risk_level: string | null;
  risk_reasons: string[];
  last_phase: string | null;
  last_progress_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface SanitizedBrowserCommand {
  host: string | null;
  summary: string;
  retryable: boolean;
  retry_payload: BrowserCommandPayload | null;
}

const MAX_ERROR = 1000;
const MAX_SUMMARY = 500;
const now = () => new Date().toISOString();

export function initBrowserCommandLogSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS browser_command_log (
      cmd_id        TEXT PRIMARY KEY,
      type          TEXT NOT NULL,
      status        TEXT NOT NULL,
      host          TEXT,
      tab_id        INTEGER,
      summary       TEXT NOT NULL,
      retryable     INTEGER NOT NULL DEFAULT 0,
      retry_payload TEXT,
      risk_level    TEXT,
      risk_reasons  TEXT NOT NULL DEFAULT '[]',
      last_phase     TEXT,
      last_progress_at TEXT,
      error         TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      completed_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_browser_command_log_created ON browser_command_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_browser_command_log_status ON browser_command_log(status, created_at DESC);
  `);
  const cols = getDb().prepare("PRAGMA table_info(browser_command_log)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((col) => col.name));
  if (!names.has("last_phase")) getDb().exec("ALTER TABLE browser_command_log ADD COLUMN last_phase TEXT");
  if (!names.has("last_progress_at")) getDb().exec("ALTER TABLE browser_command_log ADD COLUMN last_progress_at TEXT");
}

export function sanitizeBrowserCommandPayload(payload: BrowserCommandPayload): SanitizedBrowserCommand {
  switch (payload.type) {
    case "navigate": {
      const host = hostFromUrl(payload.url);
      const retryable = isRetryableUrl(payload.url);
      return {
        host,
        summary: truncate(`Navigate to ${summarizeUrl(payload.url)}`),
        retryable,
        retry_payload: retryable ? payload : null,
      };
    }
    case "click":
      return {
        host: null,
        summary: truncate(`Click ${payload.selector}`),
        retryable: true,
        retry_payload: payload,
      };
    case "fill":
      return {
        host: null,
        summary: truncate(`Fill ${payload.selector}${payload.submit ? " and submit" : ""}`),
        retryable: false,
        retry_payload: null,
      };
    case "fill_many":
      return {
        host: null,
        summary: truncate(`Fill ${payload.fields.length} fields${payload.submit_selector ? " and submit" : ""}`),
        retryable: false,
        retry_payload: null,
      };
    case "scroll":
      return {
        host: null,
        summary: truncate(payload.selector ? `Scroll ${payload.to} ${payload.selector}` : `Scroll ${payload.to}`),
        retryable: true,
        retry_payload: payload,
      };
    case "screenshot":
      return {
        host: null,
        summary: truncate(payload.selector ? `Screenshot ${payload.selector}` : "Screenshot viewport"),
        retryable: true,
        retry_payload: payload,
      };
    case "extract":
      return {
        host: null,
        summary: truncate(payload.selector ? `Extract ${payload.format ?? "text"} from ${payload.selector}` : `Extract ${payload.format ?? "text"} from page`),
        retryable: true,
        retry_payload: payload,
      };
    case "snapshot":
      return {
        host: null,
        summary: "Snapshot page controls",
        retryable: true,
        retry_payload: payload,
      };
    case "tabs":
      return {
        host: null,
        summary: "List browser tabs",
        retryable: true,
        retry_payload: payload,
      };
    case "activate_tab":
      return {
        host: null,
        summary: `Focus tab ${payload.tab_id}`,
        retryable: true,
        retry_payload: payload,
      };
  }
}

export function createBrowserCommandLog(cmdId: string, payload: BrowserCommandPayload): void {
  initBrowserCommandLogSchema();
  const sanitized = sanitizeBrowserCommandPayload(payload);
  const risk = classifySanitizedRisk(payload);
  const t = now();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO browser_command_log
      (cmd_id,type,status,host,tab_id,summary,retryable,retry_payload,risk_level,risk_reasons,last_phase,last_progress_at,error,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      cmdId,
      payload.type,
      "queued",
      sanitized.host,
      null,
      sanitized.summary,
      sanitized.retryable ? 1 : 0,
      sanitized.retry_payload ? JSON.stringify(sanitized.retry_payload) : null,
      risk.level,
      JSON.stringify(risk.reasons),
      "queued",
      t,
      null,
      t,
      t,
      null,
    );
}

export function markBrowserCommandRunning(cmdId: string): void {
  initBrowserCommandLogSchema();
  const t = now();
  getDb().prepare("UPDATE browser_command_log SET status='running', last_phase=COALESCE(last_phase, 'picked'), last_progress_at=COALESCE(last_progress_at, ?), updated_at=? WHERE cmd_id=?").run(t, t, cmdId);
}

export function markBrowserCommandProgress(cmdId: string, phase: string): void {
  initBrowserCommandLogSchema();
  const safe = sanitizePhase(phase);
  if (!safe) return;
  const t = now();
  getDb()
    .prepare("UPDATE browser_command_log SET status=CASE WHEN status='queued' THEN 'running' ELSE status END, last_phase=?, last_progress_at=?, updated_at=? WHERE cmd_id=?")
    .run(safe, t, t, cmdId);
}

export function completeBrowserCommandLog(cmdId: string, result: { ok: boolean; data?: unknown; error?: string }): void {
  initBrowserCommandLogSchema();
  const t = now();
  const tabId = extractTabId(result.data);
  getDb()
    .prepare("UPDATE browser_command_log SET status=?, tab_id=COALESCE(?, tab_id), error=?, updated_at=?, completed_at=? WHERE cmd_id=?")
    .run(result.ok ? "succeeded" : "failed", tabId, result.ok ? null : truncate(result.error ?? "unknown error", MAX_ERROR), t, t, cmdId);
}

export function updateBrowserCommandRisk(cmdId: string, risk: { level?: string; reasons?: string[] } | null): void {
  if (!risk) return;
  initBrowserCommandLogSchema();
  getDb()
    .prepare("UPDATE browser_command_log SET risk_level=?, risk_reasons=?, updated_at=? WHERE cmd_id=?")
    .run(risk.level ?? null, JSON.stringify(Array.isArray(risk.reasons) ? risk.reasons : []), now(), cmdId);
}

export function listBrowserCommandLogs(limit = 50): BrowserCommandLogEntry[] {
  initBrowserCommandLogSchema();
  const capped = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = getDb()
    .prepare("SELECT * FROM browser_command_log ORDER BY created_at DESC LIMIT ?")
    .all(capped) as Array<Record<string, unknown>>;
  return rows.map(rowToEntry);
}

export function getBrowserCommandLog(cmdId: string): BrowserCommandLogEntry | null {
  initBrowserCommandLogSchema();
  const row = getDb().prepare("SELECT * FROM browser_command_log WHERE cmd_id=?").get(cmdId) as Record<string, unknown> | undefined;
  return row ? rowToEntry(row) : null;
}

function rowToEntry(row: Record<string, unknown>): BrowserCommandLogEntry {
  return {
    cmd_id: String(row.cmd_id),
    type: String(row.type),
    status: String(row.status) as BrowserCommandStatus,
    host: typeof row.host === "string" ? row.host : null,
    tab_id: typeof row.tab_id === "number" ? row.tab_id : null,
    summary: String(row.summary ?? ""),
    retryable: Number(row.retryable) === 1,
    retry_payload: parsePayload(row.retry_payload),
    risk_level: typeof row.risk_level === "string" ? row.risk_level : null,
    risk_reasons: parseStringArray(row.risk_reasons),
    last_phase: typeof row.last_phase === "string" ? row.last_phase : null,
    last_progress_at: typeof row.last_progress_at === "string" ? row.last_progress_at : null,
    error: typeof row.error === "string" ? row.error : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: typeof row.completed_at === "string" ? row.completed_at : null,
  };
}

function parsePayload(raw: unknown): BrowserCommandPayload | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try { return JSON.parse(raw) as BrowserCommandPayload; } catch { return null; }
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function extractTabId(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const raw = (data as Record<string, unknown>).tab_id;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : null;
}

function classifySanitizedRisk(payload: BrowserCommandPayload): { level: string | null; reasons: string[] } {
  const reasons: string[] = [];
  if (payload.type === "screenshot") reasons.push("captures visible page pixels");
  if (payload.type === "extract" && !payload.selector) reasons.push("reads the whole page");
  if (payload.type === "extract" && payload.format && payload.format !== "text") reasons.push("reads page markup");
  if (payload.type === "fill" && /pass|token|secret|otp|card|cvv|cvc|iban|ssn|personnummer/i.test(payload.selector)) {
    reasons.push("sensitive field selector");
  }
  if (payload.type === "fill_many") {
    if (payload.fields.length >= 5) reasons.push("batch form fill");
    if (payload.fields.some((field) => /pass|token|secret|otp|card|cvv|cvc|iban|ssn|personnummer|email|phone|address/i.test(field.selector))) {
      reasons.push("sensitive field in batch fill");
    }
  }
  return reasons.length > 0 ? { level: "sensitive", reasons: Array.from(new Set(reasons)) } : { level: null, reasons: [] };
}

function hostFromUrl(value: string): string | null {
  try { return new URL(value).hostname; } catch { return null; }
}

function summarizeUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = `${url.pathname}${url.search ? "?…" : ""}${url.hash ? "#…" : ""}`;
    return `${url.hostname}${path}`;
  } catch {
    return value;
  }
}

function isRetryableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.search && !url.hash && value.length <= 500;
  } catch {
    return false;
  }
}

function truncate(value: string, max = MAX_SUMMARY): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function sanitizePhase(phase: string): string | null {
  const safe = String(phase || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  return safe || null;
}
