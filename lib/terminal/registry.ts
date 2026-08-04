// Global session registry — same Symbol pattern as workspace-context.ts so
// multiple Next.js module instances (HMR, route bundles) share one map.

import { TerminalSession } from "./session";

const REG_KEY = Symbol.for("@jarela/terminal-registry");
type Global = typeof globalThis & { [REG_KEY]?: Map<string, TerminalSession> };

function store(): Map<string, TerminalSession> {
  const g = globalThis as Global;
  if (!g[REG_KEY]) g[REG_KEY] = new Map();
  return g[REG_KEY]!;
}

export function getSession(sessionId: string): TerminalSession | undefined {
  const s = store().get(sessionId);
  if (s?.isDead) { store().delete(sessionId); return undefined; }
  return s;
}

export function putSession(session: TerminalSession): void {
  store().set(session.sessionId, session);
}

export function removeSession(sessionId: string): void {
  const s = store().get(sessionId);
  if (s) { s.close(); store().delete(sessionId); }
}

export function listSessions(): { sessionId: string; shell: string; idleMs: number; pid: number | undefined; cwd: string }[] {
  const out = [];
  for (const [id, s] of store()) {
    if (s.isDead) { store().delete(id); continue; }
    out.push({ sessionId: id, shell: s.shell, idleMs: s.idleMs, pid: s.pid, cwd: s.cwd });
  }
  return out;
}

export function sessionCount(): number {
  return store().size;
}

/** Close sessions idle longer than ttlMs. Called by the scheduler tick. */
export function evictIdleSessions(ttlMs: number): void {
  for (const [id, s] of store()) {
    if (s.isDead || s.idleMs > ttlMs) {
      s.close();
      store().delete(id);
    }
  }
}
