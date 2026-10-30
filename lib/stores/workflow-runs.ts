import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const rowSchema = z.strictObject({
  id: z.string().uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.number().int().positive(), owner: z.string().min(1).max(240),
  state: z.string().max(512 * 1024),
});
export type WorkflowRunRow = z.infer<typeof rowSchema>;

// Inactive internal store: construction is explicit; no startup/schema hook.
export class WorkflowRunStore {
  constructor(readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS bounded_workflow_runs (
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
