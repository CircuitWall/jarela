import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { decrypt, encrypt } from "@/lib/crypto/envelope";

const rowSchema = z.strictObject({
  id: z.string().uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.number().int().positive(), owner: z.string().min(1).max(240),
  state: z.string().max(512 * 1024),
});
export type WorkflowRunRow = z.infer<typeof rowSchema>;

export function cleanupWorkflowRuns(database: DatabaseSync, now = Date.now(), limit = 100): number {
  z.number().int().min(1).max(100).parse(limit);
  migrateWorkflowRuns(database);
  return Number(database.prepare(`DELETE FROM durable_workflow_runs WHERE id IN
    (SELECT id FROM durable_workflow_runs WHERE expires_at IS NOT NULL AND expires_at<=? ORDER BY expires_at LIMIT ?)`)
    .run(now, limit).changes);
}

// Inactive internal store: construction is explicit; no startup/schema hook.
export class WorkflowRunStore {
  constructor(readonly database: DatabaseSync, initialize = true) {
    if (initialize) database.exec(`CREATE TABLE IF NOT EXISTS bounded_workflow_runs (
      id TEXT PRIMARY KEY, revision TEXT NOT NULL, version INTEGER NOT NULL,
      owner TEXT NOT NULL, state TEXT NOT NULL
    )`);
  }

  create(row: Omit<WorkflowRunRow, "version">): WorkflowRunRow {
    const checked = rowSchema.parse({ ...row, version: 1 });
    this.#checkSize(checked.state);
    this.database.prepare("INSERT INTO bounded_workflow_runs (id, revision, version, owner, state) VALUES (?, ?, ?, ?, ?)")
      .run(checked.id, checked.revision, checked.version, checked.owner, checked.state);
    return checked;
  }

  get(id: string): WorkflowRunRow {
    const row = this.database.prepare("SELECT id, revision, version, owner, state FROM bounded_workflow_runs WHERE id=?").get(id);
    if (!row) throw new Error("Workflow run not found");
    const checked = rowSchema.parse(row);
    this.#checkSize(checked.state);
    return checked;
  }

  save(prior: WorkflowRunRow, state: string, owner = prior.owner): WorkflowRunRow {
    const checked = rowSchema.parse({ ...prior, version: prior.version + 1, state, owner });
    this.#checkSize(state);
    const result = this.database.prepare(`UPDATE bounded_workflow_runs SET version=?, owner=?, state=?
      WHERE id=? AND version=? AND owner=? AND revision=?`)
      .run(checked.version, owner, state, prior.id, prior.version, prior.owner, prior.revision);
    if (result.changes !== 1) throw new Error("Workflow run changed; reload before acting");
    return checked;
  }

  #checkSize(state: string): void {
    if (Buffer.byteLength(state, "utf8") > 512 * 1024) throw new Error("Workflow state exceeds 512 KiB");
  }
}

export const WORKFLOW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const WORKFLOW_MAX_RUNS = 1000;
const agentIdSchema = z.string().min(1).max(200);
const workspaceSchema = z.string().min(1).max(4096);
const durableSchema = rowSchema.extend({
  agentId: agentIdSchema, workspace: workspaceSchema,
});
const initialized = new WeakSet<DatabaseSync>();

// Agent deletion must remove every run in the same SQLite statement. Fail
// closed when the connection cannot enforce that or a pre-release table lacks it.
function assertAgentCascade(database: DatabaseSync): void {
  if (database.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1) {
    throw new Error("Workflow storage requires SQLite foreign key enforcement");
  }
  const agentKey = database.prepare("PRAGMA table_info(agent_configs)").all()
    .some((column) => column.name === "id" && column.pk === 1);
  const cascade = database.prepare("PRAGMA foreign_key_list(durable_workflow_runs)").all()
    .some((key) => key.table === "agent_configs" && key.from === "agent_id" && key.to === "id" && key.on_delete === "CASCADE");
  if (!agentKey || !cascade) throw new Error("Unsupported workflow storage schema");
}

export function migrateWorkflowRuns(database: DatabaseSync): void {
  if (initialized.has(database)) {
    assertAgentCascade(database);
    return;
  }
  database.exec(`SAVEPOINT workflow_schema;
    CREATE TABLE IF NOT EXISTS workflow_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL);
    INSERT OR IGNORE INTO workflow_schema VALUES (1, 0);`);
  try {
    const version = database.prepare("SELECT version FROM workflow_schema WHERE singleton=1").get()?.version;
    if (version !== 0 && version !== 1) throw new Error("Unsupported workflow storage schema");
    if (version === 0) database.exec(`
      CREATE TABLE durable_workflow_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agent_configs(id) ON DELETE CASCADE,
        revision TEXT NOT NULL,
        version INTEGER NOT NULL, owner TEXT NOT NULL, payload TEXT NOT NULL,
        phase TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        expires_at INTEGER
      );
      CREATE INDEX durable_workflow_agent ON durable_workflow_runs(agent_id,id);
      CREATE INDEX durable_workflow_expiry ON durable_workflow_runs(expires_at);
      UPDATE workflow_schema SET version=1 WHERE singleton=1;`);
    assertAgentCascade(database);
    database.exec("RELEASE workflow_schema");
    initialized.add(database);
  } catch (error) {
    database.exec("ROLLBACK TO workflow_schema; RELEASE workflow_schema");
    throw error;
  }
}

// The inactive bounded store remains useful for coordinator fixtures. App runs
// use this agent-scoped store; plaintext legacy rows are never adopted.
export class DurableWorkflowRunStore extends WorkflowRunStore {
  readonly agentId: string;
  constructor(database: DatabaseSync, agentId: string, readonly workspace = "", readonly clock = Date.now) {
    super(database, false);
    this.agentId = agentIdSchema.parse(agentId);
    migrateWorkflowRuns(database);
  }

  override create(row: Omit<WorkflowRunRow, "version">): WorkflowRunRow {
    const checked = rowSchema.parse({ ...row, version: 1 });
    const workspace = workspaceSchema.parse(this.workspace);
    const phase = this.#phase(checked.state);
    const payload = this.#encode(checked, workspace);
    this.database.exec("SAVEPOINT workflow_create");
    try {
      this.cleanup();
      const count = this.database.prepare("SELECT count(*) AS count FROM durable_workflow_runs").get()!.count as number;
      if (count >= WORKFLOW_MAX_RUNS) throw new Error("Workflow retention capacity reached");
      this.database.prepare(`INSERT INTO durable_workflow_runs
        (id,agent_id,revision,version,owner,payload,phase,created_at,updated_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(checked.id, this.agentId, checked.revision, checked.version,
        checked.owner, payload, phase, this.clock(), this.clock(), this.#expiry(phase));
      this.database.exec("RELEASE workflow_create");
      return checked;
    } catch (error) {
      this.database.exec("ROLLBACK TO workflow_create; RELEASE workflow_create");
      throw error;
    }
  }

  override get(id: string): WorkflowRunRow {
    const { revision, version, owner, state } = this.#read(id);
    return { id, revision, version, owner, state };
  }

  getWorkspace(id: string): string {
    return this.#read(id).workspace;
  }

  list(limit = 50, after?: string): WorkflowRunRow[] {
    z.number().int().min(1).max(100).parse(limit);
    if (after) z.string().uuid().parse(after);
    const rows = this.database.prepare(`SELECT id FROM durable_workflow_runs
      WHERE agent_id=? AND id>? ORDER BY id LIMIT ?`).all(this.agentId, after ?? "", limit);
    return rows.map((row) => this.get(row.id as string));
  }

  override save(prior: WorkflowRunRow, state: string, owner = prior.owner): WorkflowRunRow {
    const current = this.#read(prior.id);
    const checked = rowSchema.parse({ ...prior, version: prior.version + 1, state, owner });
    const phase = this.#phase(state);
    const payload = this.#encode(checked, current.workspace);
    const result = this.database.prepare(`UPDATE durable_workflow_runs
      SET version=?, owner=?, payload=?, phase=?, updated_at=?, expires_at=?
      WHERE id=? AND agent_id=? AND version=? AND owner=? AND revision=?`)
      .run(checked.version, owner, payload, phase, this.clock(), this.#expiry(phase),
        prior.id, this.agentId, prior.version, prior.owner, prior.revision);
    if (result.changes !== 1) throw new Error("Workflow run changed; reload before acting");
    return checked;
  }

  cleanup(limit = 100): number {
    return cleanupWorkflowRuns(this.database, this.clock(), limit);
  }

  #read(id: string) {
    z.string().uuid().parse(id);
    const row = this.database.prepare("SELECT * FROM durable_workflow_runs WHERE id=? AND agent_id=?").get(id, this.agentId);
    if (!row) throw new Error("Workflow run not found");
    const checked = durableSchema.parse(JSON.parse(decrypt(row.payload as string)));
    if (checked.id !== row.id || checked.agentId !== row.agent_id || checked.revision !== row.revision
      || checked.version !== row.version || checked.owner !== row.owner || this.#phase(checked.state) !== row.phase) {
      throw new Error("Workflow storage identity mismatch");
    }
    return checked;
  }

  #encode(row: WorkflowRunRow, workspace: string): string {
    if (Buffer.byteLength(row.state, "utf8") > 512 * 1024) throw new Error("Workflow state exceeds 512 KiB");
    return encrypt(JSON.stringify(durableSchema.parse({ ...row, agentId: this.agentId, workspace })));
  }

  #phase(state: string): string {
    if (Buffer.byteLength(state, "utf8") > 512 * 1024) throw new Error("Workflow state exceeds 512 KiB");
    return z.enum(["ready", "running", "waiting", "uncertain", "completed", "failed", "cancelled"])
      .parse((JSON.parse(state) as { phase?: unknown }).phase);
  }

  #expiry(phase: string): number | null {
    return ["completed", "failed", "cancelled"].includes(phase) ? this.clock() + WORKFLOW_RETENTION_MS : null;
  }
}
