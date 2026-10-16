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

describe("NodeSqliteSaver edge cases", () => {
  async function chain(saver: NodeSqliteSaver, thread: string, count: number, ns = ""): Promise<string[]> {
    const ids: string[] = [];
    let parent: string | undefined;
    for (let i = 0; i < count; i++) {
      const ck = newCheckpoint();
      await saver.put(
        { configurable: { thread_id: thread, checkpoint_ns: ns, ...(parent ? { checkpoint_id: parent } : {}) } },
        ck,
        { ...META_BASE, step: i },
      );
      ids.push(ck.id);
      parent = ck.id;
    }
    return ids;
  }

  it("links each checkpoint to its parent and returns no parent for the first one", async () => {
    const saver = newSaver();
    const [first, second] = await chain(saver, "t-parent", 2);
    const latest = await saver.getTuple(cfg("t-parent"));
    expect(latest?.checkpoint.id).toBe(second);
    expect(latest?.parentConfig?.configurable?.checkpoint_id).toBe(first);
    expect((await saver.getTuple(cfg("t-parent", first)))?.parentConfig).toBeUndefined();
  });

  it("keeps checkpoint namespaces (subgraphs) isolated within one thread", async () => {
    const saver = newSaver();
    const [root] = await chain(saver, "t-ns", 1, "");
    const [child] = await chain(saver, "t-ns", 1, "sub:1");
    const rootLatest = await saver.getTuple({ configurable: { thread_id: "t-ns", checkpoint_ns: "" } });
    const childLatest = await saver.getTuple({ configurable: { thread_id: "t-ns", checkpoint_ns: "sub:1" } });
    expect(rootLatest?.checkpoint.id).toBe(root);
    expect(childLatest?.checkpoint.id).toBe(child);
    expect(childLatest?.config.configurable?.checkpoint_ns).toBe("sub:1");
  });

  it("pages list() with before, newest first, without repeating the cursor", async () => {
    const saver = newSaver();
    const ids = await chain(saver, "t-before", 4);
    const page = [];
    for await (const tuple of saver.list(cfg("t-before"), { before: cfg("t-before", ids[2]), limit: 10 })) page.push(tuple.checkpoint.id);
    expect(page).toEqual([ids[1], ids[0]]);
  });

  it("returns pending writes for the checkpoint they belong to, and replaces a retried task's writes", async () => {
    const saver = newSaver();
    const [first, second] = await chain(saver, "t-writes", 2);
    await saver.putWrites(cfg("t-writes", second), [["messages", { text: "draft" }], ["status", "running"]], "task-1");
    await saver.putWrites(cfg("t-writes", second), [["messages", { text: "final" }], ["status", "done"]], "task-1");
    await saver.putWrites(cfg("t-writes", first), [["messages", { text: "old" }]], "task-0");

    const latest = await saver.getTuple(cfg("t-writes"));
    expect(latest?.pendingWrites).toEqual([
      ["task-1", "messages", { text: "final" }],
      ["task-1", "status", "done"],
    ]);
    const older = await saver.getTuple(cfg("t-writes", first));
    expect(older?.pendingWrites).toEqual([["task-0", "messages", { text: "old" }]]);
  });

  it("round-trips non-ASCII and large channel values", async () => {
    const saver = newSaver();
    const ck = newCheckpoint();
    const text = `你好 👋 ${"x".repeat(200_000)}`;
    (ck.channel_values as Record<string, unknown>).messages = [{ text }];
    await saver.put(cfg("t-big"), ck, META_BASE);
    await saver.putWrites(cfg("t-big", ck.id), [["note", text]], "task");
    const tuple = await saver.getTuple(cfg("t-big"));
    expect((tuple?.checkpoint.channel_values as Record<string, unknown>).messages).toEqual([{ text }]);
    expect(tuple?.pendingWrites?.[0][2]).toBe(text);
  });

  it("rejects writes without a checkpoint_id and puts without a thread_id", async () => {
    const saver = newSaver();
    await expect(saver.putWrites(cfg("t-x"), [["c", 1]], "task")).rejects.toThrow(/checkpoint_id/);
    await expect(saver.put({ configurable: {} }, newCheckpoint(), META_BASE)).rejects.toThrow(/thread_id/);
  });

  it("deleteThread leaves other threads untouched", async () => {
    const saver = newSaver();
    const [keep] = await chain(saver, "t-keep", 1);
    const [drop] = await chain(saver, "t-drop", 1);
    await saver.putWrites(cfg("t-keep", keep), [["c", 1]], "task");
    await saver.putWrites(cfg("t-drop", drop), [["c", 2]], "task");
    await saver.deleteThread("t-drop");
    expect(await saver.getTuple(cfg("t-drop"))).toBeUndefined();
    expect((await saver.getTuple(cfg("t-keep")))?.pendingWrites).toEqual([["task", "c", 1]]);
  });
});