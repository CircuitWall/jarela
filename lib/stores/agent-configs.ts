import { getDb } from "@/lib/db";

const now = () => new Date().toISOString();

export interface AgentConfigRow {
  id: string;
  name: string;
  icon: string | null;
  identity: string;
  instructions: string;
  tools: string;              // JSON string[]
  model_config_name: string | null;
  is_default: number;
  history_limit: number;        // 0 = unlimited
  history_window_hours: number; // 0 = no time bound
  never_reply: number;          // 1 = run the agent but don't auto-send replies via bridges
  created_at: string;
  updated_at: string;
}

export function listAgentConfigs(): AgentConfigRow[] {
  return getDb()
    .prepare("SELECT * FROM agent_configs ORDER BY is_default DESC, created_at ASC")
    .all() as unknown as AgentConfigRow[];
}

export function getDefaultAgentConfig(): AgentConfigRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM agent_configs WHERE is_default=1 LIMIT 1")
      .get() as unknown as AgentConfigRow) ?? null
  );
}

export function getAgentConfig(id: string): AgentConfigRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM agent_configs WHERE id=?")
      .get(id) as unknown as AgentConfigRow) ?? null
  );
}

export interface UpsertAgentInput {
  id: string;
  name: string;
  icon?: string | null;
  identity: string;
  instructions: string;
  tools: string[];
  model_config_name?: string | null;
  is_default?: boolean;
  history_limit?: number;
  history_window_hours?: number;
  never_reply?: boolean;
}

export function upsertAgentConfig(input: UpsertAgentInput): AgentConfigRow {
  const t = now();
  const db = getDb();
  const existing = getAgentConfig(input.id);
  const created_at = existing?.created_at ?? t;
  if (input.is_default) db.prepare("UPDATE agent_configs SET is_default=0").run();
  db.prepare(
      `INSERT OR REPLACE INTO agent_configs
        (id, name, icon, identity, instructions, tools, model_config_name, is_default,
         history_limit, history_window_hours, never_reply, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.name,
      input.icon ?? null,
      input.identity,
      input.instructions,
      JSON.stringify(input.tools),
      input.model_config_name ?? null,
      input.is_default ? 1 : (existing?.is_default ?? 0),
      input.history_limit ?? existing?.history_limit ?? 50,
      input.history_window_hours ?? existing?.history_window_hours ?? 8,
      // never_reply is a boolean toggle — explicit `undefined` means "keep existing"
      // (important for PATCH-style updates that omit the field).
      input.never_reply === undefined
        ? (existing?.never_reply ?? 0)
        : (input.never_reply ? 1 : 0),
      created_at,
      t,
    );
  return getAgentConfig(input.id)!;
}

export function deleteAgentConfig(id: string): boolean {
  return (
    (getDb().prepare("DELETE FROM agent_configs WHERE id=?").run(id) as { changes: number }).changes > 0
  );
}

export function generateAgentId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 6);
  return slug ? `${slug}-${suffix}` : `agent-${suffix}`;
}
