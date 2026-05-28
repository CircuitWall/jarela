import { DatabaseSync, type StatementSync } from "node:sqlite";
import { type RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  TASKS,
  copyCheckpoint,
  maxChannelVersion,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint";

// In-tree LangGraph checkpoint saver backed by node:sqlite.
//
// Schema-compatible drop-in replacement for SqliteSaver from
// @langchain/langgraph-checkpoint-sqlite. The DDL is byte-identical so an
// existing checkpoints.db keeps working without migration.

const VALID_FILTER_KEYS: readonly string[] = ["source", "step", "parents"];

type Row = Record<string, unknown>;

function buildLatestSelect(includeCheckpointId: boolean): string {
  return `
  SELECT
    thread_id,
    checkpoint_ns,
    checkpoint_id,
    parent_checkpoint_id,
    type,
    checkpoint,
    metadata,
    (
      SELECT
        json_group_array(
          json_object(
            'task_id', pw.task_id,
            'channel', pw.channel,
            'type', pw.type,
            'value', CAST(pw.value AS TEXT)
          )
        )
      FROM writes as pw
      WHERE pw.thread_id = checkpoints.thread_id
        AND pw.checkpoint_ns = checkpoints.checkpoint_ns
        AND pw.checkpoint_id = checkpoints.checkpoint_id
    ) as pending_writes,
    (
      SELECT
        json_group_array(
          json_object(
            'type', ps.type,
            'value', CAST(ps.value AS TEXT)
          )
        )
      FROM writes as ps
      WHERE ps.thread_id = checkpoints.thread_id
        AND ps.checkpoint_ns = checkpoints.checkpoint_ns
        AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
        AND ps.channel = '${TASKS}'
      ORDER BY ps.idx
    ) as pending_sends
  FROM checkpoints
  WHERE thread_id = ? AND checkpoint_ns = ? ${
    includeCheckpointId
      ? "AND checkpoint_id = ?"
      : "ORDER BY checkpoint_id DESC LIMIT 1"
  }`;
}

// node:sqlite rejects `undefined` parameter binds; coerce to null.
function nv<T>(v: T | undefined | null): T | null {
  return v === undefined ? null : (v as T | null);
}

export class NodeSqliteSaver extends BaseCheckpointSaver {
  db: DatabaseSync;

  protected isSetup = false;
  protected withoutCheckpoint!: StatementSync;
  protected withCheckpoint!: StatementSync;

  constructor(db: DatabaseSync, serde?: SerializerProtocol) {
    super(serde);
    this.db = db;
  }

  static fromConnString(connStringOrLocalPath: string): NodeSqliteSaver {
    return new NodeSqliteSaver(new DatabaseSync(connStringOrLocalPath));
  }

  protected setup(): void {
    if (this.isSetup) return;
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint BLOB,
  metadata BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);`);
    this.db.exec(`
CREATE TABLE IF NOT EXISTS writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);`);
    this.withoutCheckpoint = this.db.prepare(buildLatestSelect(false));
    this.withCheckpoint = this.db.prepare(buildLatestSelect(true));
    this.isSetup = true;
  }

  protected txn<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failure; surface the original error
      }
      throw err;
    }
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.setup();
    const { thread_id, checkpoint_ns = "", checkpoint_id } =
      config.configurable ?? {};
    const args: unknown[] = [nv(thread_id), checkpoint_ns];
    if (checkpoint_id) args.push(checkpoint_id);
    const stmt = checkpoint_id ? this.withCheckpoint : this.withoutCheckpoint;
    const row = stmt.get(...(args as never[])) as Row | undefined;
    if (row === undefined) return undefined;

    let finalConfig = config;
    if (!checkpoint_id) {
      finalConfig = {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
        },
      };
    }
    if (
      finalConfig.configurable?.thread_id === undefined ||
      finalConfig.configurable?.checkpoint_id === undefined
    ) {
      throw new Error("Missing thread_id or checkpoint_id");
    }

    const pendingWrites = await Promise.all(
      JSON.parse(String(row.pending_writes ?? "[]")).map(
        async (write: { task_id: string; channel: string; type?: string; value?: string }) => {
          return [
            write.task_id,
            write.channel,
            await this.serde.loadsTyped(write.type ?? "json", write.value ?? ""),
          ] as [string, string, unknown];
        },
      ),
    );

    const checkpoint = (await this.serde.loadsTyped(
      (row.type as string | null) ?? "json",
      row.checkpoint as Uint8Array | string,
    )) as Checkpoint;

    if (checkpoint.v < 4 && row.parent_checkpoint_id != null) {
      await this.migratePendingSends(
        checkpoint,
        row.thread_id as string,
        row.parent_checkpoint_id as string,
      );
    }

    return {
      checkpoint,
      config: finalConfig,
      metadata: (await this.serde.loadsTyped(
        (row.type as string | null) ?? "json",
        row.metadata as Uint8Array | string,
      )) as CheckpointMetadata,
      parentConfig: row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns,
              checkpoint_id: row.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites,
    };
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {};
    this.setup();
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns;

    let sql = `
      SELECT
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        parent_checkpoint_id,
        type,
        checkpoint,
        metadata,
        (
          SELECT
            json_group_array(
              json_object(
                'task_id', pw.task_id,
                'channel', pw.channel,
                'type', pw.type,
                'value', CAST(pw.value AS TEXT)
              )
            )
          FROM writes as pw
          WHERE pw.thread_id = checkpoints.thread_id
            AND pw.checkpoint_ns = checkpoints.checkpoint_ns
            AND pw.checkpoint_id = checkpoints.checkpoint_id
        ) as pending_writes,
        (
          SELECT
            json_group_array(
              json_object(
                'type', ps.type,
                'value', CAST(ps.value AS TEXT)
              )
            )
          FROM writes as ps
          WHERE ps.thread_id = checkpoints.thread_id
            AND ps.checkpoint_ns = checkpoints.checkpoint_ns
            AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
            AND ps.channel = '${TASKS}'
          ORDER BY ps.idx
        ) as pending_sends
      FROM checkpoints\n`;

    const whereClause: string[] = [];
    if (thread_id) whereClause.push("thread_id = ?");
    if (checkpoint_ns !== undefined && checkpoint_ns !== null) {
      whereClause.push("checkpoint_ns = ?");
    }
    if (before?.configurable?.checkpoint_id !== undefined) {
      whereClause.push("checkpoint_id < ?");
    }

    const sanitizedFilter = Object.fromEntries(
      Object.entries(filter ?? {}).filter(
        ([key, value]) => value !== undefined && VALID_FILTER_KEYS.includes(key),
      ),
    );
    whereClause.push(
      ...Object.entries(sanitizedFilter).map(
        ([key]) => `jsonb(CAST(metadata AS TEXT))->'$.${key}' = ?`,
      ),
    );
    if (whereClause.length > 0) sql += `WHERE\n  ${whereClause.join(" AND\n  ")}\n`;
    sql += "\nORDER BY checkpoint_id DESC";
    if (limit) sql += ` LIMIT ${parseInt(String(limit), 10)}`;

    const args: unknown[] = [
      thread_id,
      checkpoint_ns,
      before?.configurable?.checkpoint_id,
      ...Object.values(sanitizedFilter).map((value) => JSON.stringify(value)),
    ].filter((value) => value !== undefined && value !== null);

    const rows = this.db.prepare(sql).all(...(args as never[])) as Row[];
    for (const row of rows) {
      const pendingWrites = await Promise.all(
        JSON.parse(String(row.pending_writes ?? "[]")).map(
          async (write: { task_id: string; channel: string; type?: string; value?: string }) => {
            return [
              write.task_id,
              write.channel,
              await this.serde.loadsTyped(write.type ?? "json", write.value ?? ""),
            ] as [string, string, unknown];
          },
        ),
      );
      const checkpoint = (await this.serde.loadsTyped(
        (row.type as string | null) ?? "json",
        row.checkpoint as Uint8Array | string,
      )) as Checkpoint;
      if (checkpoint.v < 4 && row.parent_checkpoint_id != null) {
        await this.migratePendingSends(
          checkpoint,
          row.thread_id as string,
          row.parent_checkpoint_id as string,
        );
      }
      yield {
        config: {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.checkpoint_id,
          },
        },
        checkpoint,
        metadata: (await this.serde.loadsTyped(
          (row.type as string | null) ?? "json",
          row.metadata as Uint8Array | string,
        )) as CheckpointMetadata,
        parentConfig: row.parent_checkpoint_id
          ? {
              configurable: {
                thread_id: row.thread_id,
                checkpoint_ns: row.checkpoint_ns,
                checkpoint_id: row.parent_checkpoint_id,
              },
            }
          : undefined,
        pendingWrites,
      };
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    this.setup();
    if (!config.configurable) throw new Error("Empty configuration supplied.");
    const thread_id = config.configurable?.thread_id as string | undefined;
    const checkpoint_ns = (config.configurable?.checkpoint_ns ?? "") as string;
    const parent_checkpoint_id = config.configurable?.checkpoint_id as
      | string
      | undefined;
    if (!thread_id) {
      throw new Error(`Missing "thread_id" field in passed "config.configurable".`);
    }
    const preparedCheckpoint = copyCheckpoint(checkpoint);
    const [
      [type1, serializedCheckpoint],
      [type2, serializedMetadata],
    ] = await Promise.all([
      this.serde.dumpsTyped(preparedCheckpoint),
      this.serde.dumpsTyped(metadata),
    ]);
    if (type1 !== type2) {
      throw new Error(
        "Failed to serialized checkpoint and metadata to the same type.",
      );
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread_id,
        checkpoint_ns,
        checkpoint.id,
        nv(parent_checkpoint_id),
        type1,
        serializedCheckpoint as never,
        serializedMetadata as never,
      );
    return {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    this.setup();
    if (!config.configurable) throw new Error("Empty configuration supplied.");
    if (!config.configurable?.thread_id) {
      throw new Error("Missing thread_id field in config.configurable.");
    }
    if (!config.configurable?.checkpoint_id) {
      throw new Error("Missing checkpoint_id field in config.configurable.");
    }
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO writes
      (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const rows = await Promise.all(
      writes.map(async (write, idx) => {
        const [type, serializedWrite] = await this.serde.dumpsTyped(write[1]);
        return [
          config.configurable?.thread_id as string,
          (config.configurable?.checkpoint_ns ?? "") as string,
          config.configurable?.checkpoint_id as string,
          taskId,
          idx,
          write[0],
          type,
          serializedWrite,
        ] as const;
      }),
    );
    this.txn(() => {
      for (const row of rows) stmt.run(...(row as unknown as never[]));
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    this.setup();
    this.txn(() => {
      this.db
        .prepare(`DELETE FROM checkpoints WHERE thread_id = ?`)
        .run(threadId);
      this.db.prepare(`DELETE FROM writes WHERE thread_id = ?`).run(threadId);
    });
  }

  protected async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    parentCheckpointId: string,
  ): Promise<void> {
    const row = this.db
      .prepare(
        `
          SELECT
            checkpoint_id,
            json_group_array(
              json_object(
                'type', ps.type,
                'value', CAST(ps.value AS TEXT)
              )
            ) as pending_sends
          FROM writes as ps
          WHERE ps.thread_id = ?
            AND ps.checkpoint_id = ?
            AND ps.channel = '${TASKS}'
          ORDER BY ps.idx
        `,
      )
      .get(threadId, parentCheckpointId) as Row | undefined;
    const pendingSendsJson = String(row?.pending_sends ?? "[]");
    const mutable = checkpoint as Checkpoint & {
      channel_values?: Record<string, unknown>;
      channel_versions: Record<string, unknown>;
    };
    mutable.channel_values ??= {};
    mutable.channel_values[TASKS] = await Promise.all(
      JSON.parse(pendingSendsJson).map(
        ({ type, value }: { type?: string; value?: string }) =>
          this.serde.loadsTyped(type ?? "json", value ?? ""),
      ),
    );
    mutable.channel_versions[TASKS] =
      Object.keys(checkpoint.channel_versions).length > 0
        ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
        : this.getNextVersion(undefined);
  }
}
