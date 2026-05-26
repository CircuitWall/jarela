import { join } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { getDataDir } from "@/lib/db/data-dir";

// Persistent graph state per thread_id. Multi-step plans, scratchpad messages,
// and any pending tool-call sequence survive process restarts and resume on
// the next agent.stream() with the same thread_id.
//
// We use a separate DB file (~/.jarela/checkpoints.db) so the LangGraph
// checkpointer (better-sqlite3) doesn't contend with our own driver
// (node:sqlite) on the main jarela.db file. Both run in WAL mode.

const CHECKPOINT_PATH = join(getDataDir(), "checkpoints.db");

let _saver: SqliteSaver | null = null;

export function getCheckpointer(): SqliteSaver {
  if (!_saver) {
    _saver = SqliteSaver.fromConnString(CHECKPOINT_PATH);
  }
  return _saver;
}
