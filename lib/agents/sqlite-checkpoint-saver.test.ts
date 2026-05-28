import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { emptyCheckpoint, uuid6 } from "@langchain/langgraph-checkpoint";
import type {
  Checkpoint,
  CheckpointMetadata,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { NodeSqliteSaver } from "./sqlite-checkpoint-saver";

function newSaver(): NodeSqliteSaver {
  return new NodeSqliteSaver(new DatabaseSync(":memory:"));
}

function newCheckpoint(): Checkpoint {
  const ck = emptyCheckpoint() as Checkpoint;
  ck.id = uuid6(-1);
  return ck;
}

const META_BASE: CheckpointMetadata = {
  source: "input",
  step: 0,
  parents: {},
};

function cfg(thread_id: string, checkpoint_id?: string): RunnableConfig {
  return {
    configurable: checkpoint_id
      ? { thread_id, checkpoint_id, checkpoint_ns: "" }
      : { thread_id, checkpoint_ns: "" },
  };
}

describe("NodeSqliteSaver", () => {
  it("creates the schema with the documented DDL on first use", () => {
    const saver = newSaver();
    // Trigger setup() via any public method
    return saver.put(cfg("t-schema"), newCheckpoint(), META_BASE).then(() => {
      const tables = saver.db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as { name: string; sql: string }[];
      const names = tables.map((t) => t.name).sort();
      expect(names).toContain("checkpoints");
      expect(names).toContain("writes");
      const checkpoints = tables.find((t) => t.name === "checkpoints")!;
      expect(checkpoints.sql).toContain("PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)");
      expect(checkpoints.sql).toContain("checkpoint BLOB");
      expect(checkpoints.sql).toContain("metadata BLOB");
      const writes = tables.find((t) => t.name === "writes")!;
      expect(writes.sql).toContain(
        "PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)",
      );
    });
  });

  it("round-trips a checkpoint via put/getTuple including the latest selector", async () => {
    const saver = newSaver();
    const ck = newCheckpoint();
    const config = cfg("t-roundtrip");
    const written = await saver.put(config, ck, META_BASE);
    expect(written.configurable?.checkpoint_id).toBe(ck.id);

    const latest = await saver.getTuple(cfg("t-roundtrip"));
    expect(latest).toBeDefined();
    expect(latest!.checkpoint.id).toBe(ck.id);
    expect(latest!.metadata?.source).toBe("input");

    const byId = await saver.getTuple(cfg("t-roundtrip", ck.id));
    expect(byId?.checkpoint.id).toBe(ck.id);
  });

  it("orders list() results by checkpoint_id DESC and applies LIMIT", async () => {
    const saver = newSaver();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ck = newCheckpoint();
      ids.push(ck.id);
      await saver.put(cfg("t-list"), ck, { ...META_BASE, step: i });
    }
    const seen: string[] = [];
    for await (const tuple of saver.list(cfg("t-list"), { limit: 2 })) {
      seen.push(tuple.checkpoint.id);
    }
    expect(seen).toHaveLength(2);
    // list() orders by checkpoint_id DESC; verify both that the result is
    // a subset of inserted ids and that it is sorted descending.
    expect(new Set(seen).size).toBe(2);
    for (const id of seen) expect(ids).toContain(id);
    expect([...seen].sort().reverse()).toEqual(seen);
    // The lexicographically-largest id must be present (it sorts first DESC).
    const largest = [...ids].sort().slice(-1)[0];
    expect(seen).toContain(largest);
  });

  it("filters list() by metadata source", async () => {
    const saver = newSaver();
    await saver.put(cfg("t-filter"), newCheckpoint(), {
      ...META_BASE,
      source: "input",
    });
    await saver.put(cfg("t-filter"), newCheckpoint(), {
      ...META_BASE,
      source: "loop",
    });
    const seen: string[] = [];
    for await (const tuple of saver.list(cfg("t-filter"), {
      filter: { source: "loop" },
    })) {
      seen.push(tuple.metadata?.source ?? "");
    }
    expect(seen).toEqual(["loop"]);
  });

  it("putWrites is atomic — failure mid-batch leaves no rows", async () => {
    const saver = newSaver();
    const ck = newCheckpoint();
    await saver.put(cfg("t-tx"), ck, META_BASE);

    const config = cfg("t-tx", ck.id);
    // Inject a failure: serde.dumpsTyped throws on a poison value.
    const poison = Symbol("explode");
    const writes = [
      ["channel-a", "ok"],
      ["channel-b", poison],
    ] as [string, unknown][];
    const origDumps = saver.serde.dumpsTyped.bind(saver.serde);
    saver.serde.dumpsTyped = (async (v: unknown) => {
      if (v === poison) throw new Error("boom");
      return origDumps(v);
    }) as typeof saver.serde.dumpsTyped;

    await expect(saver.putWrites(config, writes, "task-1")).rejects.toThrow(
      "boom",
    );
    const count = saver.db
      .prepare("SELECT COUNT(*) as c FROM writes WHERE thread_id = ?")
      .get("t-tx") as { c: number };
    expect(count.c).toBe(0);
  });

  it("deleteThread removes both checkpoints and writes", async () => {
    const saver = newSaver();
    const ck = newCheckpoint();
    await saver.put(cfg("t-del"), ck, META_BASE);
    await saver.putWrites(cfg("t-del", ck.id), [["channel-a", "v"]], "task-1");

    await saver.deleteThread("t-del");

    const cp = saver.db
      .prepare("SELECT COUNT(*) as c FROM checkpoints WHERE thread_id = ?")
      .get("t-del") as { c: number };
    const wr = saver.db
      .prepare("SELECT COUNT(*) as c FROM writes WHERE thread_id = ?")
      .get("t-del") as { c: number };
    expect(cp.c).toBe(0);
    expect(wr.c).toBe(0);
  });

  it("getTuple returns undefined for an unknown thread", async () => {
    const saver = newSaver();
    const tuple = await saver.getTuple(cfg("t-missing"));
    expect(tuple).toBeUndefined();
  });
});
