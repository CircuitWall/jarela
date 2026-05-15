import { getDb } from "@/lib/db";

const now = () => new Date().toISOString();

export interface TaskAssignmentRow {
  agent_id: string;
  model_config_name: string;
  tool_policy?: { allow?: string[]; deny?: string[] };
  created_at: string;
  updated_at: string;
}

interface RawTaskAssignmentRow {
  agent_id: string;
  model_config_name: string;
  allow_tools: string;
  deny_tools: string;
  created_at: string;
  updated_at: string;
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v) => String(v)).filter((v) => v.length > 0);
  } catch {
    return [];
  }
}

function normalizeRow(raw: RawTaskAssignmentRow): TaskAssignmentRow {
  const allow = parseStringArray(raw.allow_tools);
  const deny = parseStringArray(raw.deny_tools);
  return {
    agent_id: raw.agent_id,
    model_config_name: raw.model_config_name,
    ...(allow.length || deny.length
      ? {
          tool_policy: {
            ...(allow.length ? { allow } : {}),
            ...(deny.length ? { deny } : {}),
          },
        }
      : {}),
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

export function listTaskAssignments(): TaskAssignmentRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM task_assignments ORDER BY agent_id ASC")
    .all() as unknown as RawTaskAssignmentRow[];
  return rows.map(normalizeRow);
}

export function getTaskAssignment(agent_id: string): TaskAssignmentRow | null {
  const row = getDb()
    .prepare("SELECT * FROM task_assignments WHERE agent_id=?")
    .get(agent_id) as unknown as RawTaskAssignmentRow | undefined;
  return row ? normalizeRow(row) : null;
}

export function upsertTaskAssignment(
  agent_id: string,
  model_config_name: string,
  tool_policy?: { allow?: string[]; deny?: string[] },
): TaskAssignmentRow {
  const t = now();
  const existing = getTaskAssignment(agent_id);
  const created_at = existing?.created_at ?? t;
  const allowTools = JSON.stringify(tool_policy?.allow ?? []);
  const denyTools = JSON.stringify(tool_policy?.deny ?? []);
  getDb()
    .prepare("INSERT OR REPLACE INTO task_assignments (agent_id,model_config_name,allow_tools,deny_tools,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(agent_id, model_config_name, allowTools, denyTools, created_at, t);

  return {
    agent_id,
    model_config_name,
    ...(tool_policy ? { tool_policy } : {}),
    created_at,
    updated_at: t,
  };
}

export function deleteTaskAssignment(agent_id: string): boolean {
  return getDb().prepare("DELETE FROM task_assignments WHERE agent_id=?").run(agent_id).changes > 0;
}
