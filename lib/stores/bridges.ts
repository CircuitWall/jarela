import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { getDb } from "@/lib/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BridgeKind = "whatsapp";
export type BridgeStatus = "disconnected" | "pairing" | "connected" | "error";

export interface BridgeRow {
  id: string;
  kind: BridgeKind;
  name: string;
  status: BridgeStatus;
  qr: string | null;
  last_error: string | null;
  paired_id: string | null;
  enabled: number;          // 0 | 1
  created_at: string;
  updated_at: string;
}

export interface BridgeRouteRow {
  id: string;
  bridge_id: string;
  remote_jid: string; // Specific JID or '*' catch-all for unmatched chats on this bridge
  agent_id: string;
  label: string | null;
  // 1 = run the agent on inbound messages but suppress the outbound reply.
  // Per-route so the same agent can auto-reply in one chat and stay silent
  // in another (e.g. observer in a busy group, replier in a DM).
  silent_mode: number;
  created_at: string;
  updated_at: string;
}

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Auth dir on disk (Baileys multi-file auth state)
// ---------------------------------------------------------------------------

// Mirror lib/db/index.ts so we don't depend on importing it for a directory
// path — keeps the store free of side-effects on import.
import { getDataDir } from "@/lib/db/data-dir";

export function bridgeAuthDir(bridgeId: string): string {
  return join(getDataDir(), "baileys", bridgeId);
}

export function ensureBridgeAuthDir(bridgeId: string): string {
  const dir = bridgeAuthDir(bridgeId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeBridgeAuthDir(bridgeId: string): void {
  try { rmSync(bridgeAuthDir(bridgeId), { recursive: true, force: true }); }
  catch { /* dir didn't exist, fine */ }
}

// ---------------------------------------------------------------------------
// Bridge CRUD
// ---------------------------------------------------------------------------

export function listBridges(): BridgeRow[] {
  return getDb()
    .prepare("SELECT * FROM bridges ORDER BY created_at ASC")
    .all() as unknown as BridgeRow[];
}

export function getBridge(id: string): BridgeRow | null {
  return (getDb().prepare("SELECT * FROM bridges WHERE id=?").get(id) as BridgeRow | undefined) ?? null;
}

export function createBridge(input: { kind: BridgeKind; name: string }): BridgeRow {
  const id = randomUUID();
  const t = now();
  getDb()
    .prepare(
      `INSERT INTO bridges (id, kind, name, status, qr, last_error, paired_id, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'disconnected', NULL, NULL, NULL, 0, ?, ?)`,
    )
    .run(id, input.kind, input.name, t, t);
  return {
    id,
    kind: input.kind,
    name: input.name,
    status: "disconnected",
    qr: null,
    last_error: null,
    paired_id: null,
    enabled: 0,
    created_at: t,
    updated_at: t,
  };
}

export function updateBridge(
  id: string,
  patch: Partial<Pick<BridgeRow, "name" | "enabled" | "status" | "qr" | "last_error" | "paired_id">>,
): BridgeRow | null {
  const existing = getBridge(id);
  if (!existing) return null;
  const merged: BridgeRow = {
    ...existing,
    name: patch.name ?? existing.name,
    enabled: patch.enabled ?? existing.enabled,
    status: patch.status ?? existing.status,
    qr: patch.qr !== undefined ? patch.qr : existing.qr,
    last_error: patch.last_error !== undefined ? patch.last_error : existing.last_error,
    paired_id: patch.paired_id !== undefined ? patch.paired_id : existing.paired_id,
    updated_at: now(),
  };
  getDb()
    .prepare(
      `UPDATE bridges
       SET name=?, enabled=?, status=?, qr=?, last_error=?, paired_id=?, updated_at=?
       WHERE id=?`,
    )
    .run(merged.name, merged.enabled, merged.status, merged.qr, merged.last_error, merged.paired_id, merged.updated_at, id);
  return merged;
}

export function deleteBridge(id: string): boolean {
  const db = getDb();
  db.prepare("DELETE FROM bridge_routes WHERE bridge_id=?").run(id);
  const r = db.prepare("DELETE FROM bridges WHERE id=?").run(id);
  return r.changes > 0;
}

// ---------------------------------------------------------------------------
// Route CRUD
// ---------------------------------------------------------------------------

export function listRoutes(bridgeId: string): BridgeRouteRow[] {
  return getDb()
    .prepare("SELECT * FROM bridge_routes WHERE bridge_id=? ORDER BY created_at ASC")
    .all(bridgeId) as unknown as BridgeRouteRow[];
}

export function listAllRoutes(): BridgeRouteRow[] {
  return getDb()
    .prepare("SELECT * FROM bridge_routes ORDER BY created_at ASC")
    .all() as unknown as BridgeRouteRow[];
}

export function getRoute(id: string): BridgeRouteRow | null {
  return (getDb().prepare("SELECT * FROM bridge_routes WHERE id=?").get(id) as BridgeRouteRow | undefined) ?? null;
}

export function findRoute(bridgeId: string, remoteJid: string): BridgeRouteRow | null {
  return (getDb()
    .prepare("SELECT * FROM bridge_routes WHERE bridge_id=? AND remote_jid=?")
    .get(bridgeId, remoteJid) as BridgeRouteRow | undefined) ?? null;
}

export function createRoute(input: {
  bridge_id: string;
  remote_jid: string; // Specific JID or '*' catch-all
  agent_id: string;
  label?: string | null;
  silent_mode?: boolean;
}): BridgeRouteRow {
  const id = randomUUID();
  const t = now();
  const silent = input.silent_mode ? 1 : 0;
  getDb()
    .prepare(
      `INSERT INTO bridge_routes (id, bridge_id, remote_jid, agent_id, label, silent_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.bridge_id, input.remote_jid, input.agent_id, input.label ?? null, silent, t, t);
  return {
    id,
    bridge_id: input.bridge_id,
    remote_jid: input.remote_jid,
    agent_id: input.agent_id,
    label: input.label ?? null,
    silent_mode: silent,
    created_at: t,
    updated_at: t,
  };
}

export function updateRoute(
  id: string,
  patch: {
    remote_jid?: string;
    agent_id?: string;
    label?: string | null;
    silent_mode?: boolean;
  },
): BridgeRouteRow | null {
  const existing = getRoute(id);
  if (!existing) return null;
  const merged: BridgeRouteRow = {
    ...existing,
    remote_jid: patch.remote_jid ?? existing.remote_jid,
    agent_id: patch.agent_id ?? existing.agent_id,
    label: patch.label !== undefined ? patch.label : existing.label,
    silent_mode: patch.silent_mode !== undefined ? (patch.silent_mode ? 1 : 0) : existing.silent_mode,
    updated_at: now(),
  };
  getDb()
    .prepare("UPDATE bridge_routes SET remote_jid=?, agent_id=?, label=?, silent_mode=?, updated_at=? WHERE id=?")
    .run(merged.remote_jid, merged.agent_id, merged.label, merged.silent_mode, merged.updated_at, id);
  return merged;
}

export function deleteRoute(id: string): boolean {
  const r = getDb().prepare("DELETE FROM bridge_routes WHERE id=?").run(id);
  return r.changes > 0;
}
