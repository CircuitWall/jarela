import { join } from "node:path";
import { getDataDir } from "@/lib/db/data-dir";
import { NodeSqliteSaver } from "./sqlite-checkpoint-saver";

// Persistent graph state per thread_id. Multi-step plans, scratchpad messages,
// and any pending tool-call sequence survive process restarts and resume on
// the next agent.stream() with the same thread_id.
//
// Stored in a separate DB file (~/.jarela/checkpoints.db) so LangGraph
// manages its own schema independently of our own migrations under
// lib/db/. Both files use WAL mode via the same node:sqlite driver.

const CHECKPOINT_PATH = join(getDataDir(), "checkpoints.db");

let _saver: NodeSqliteSaver | null = null;

export function getCheckpointer(): NodeSqliteSaver {
  if (!_saver) {
    _saver = NodeSqliteSaver.fromConnString(CHECKPOINT_PATH);
  }
  return _saver;
}
