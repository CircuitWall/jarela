import { homedir } from "os";
import { join } from "path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

// Persistent graph state per thread_id. Multi-step plans, scratchpad messages,
// and any pending tool-call sequence survive process restarts and resume on
// the next agent.stream() with the same thread_id.
//
// We use a separate DB file (~/.langgui/checkpoints.db) so the LangGraph
// checkpointer (better-sqlite3) doesn't contend with our own driver
// (node:sqlite) on the main langgui.db file. Both run in WAL mode.

const dbDir = process.env.LANGGUI_DB_DIR
  ? process.env.LANGGUI_DB_DIR.replace("~", homedir())
  : join(homedir(), ".langgui");

const CHECKPOINT_PATH = join(dbDir, "checkpoints.db");

let _saver: SqliteSaver | null = null;

export function getCheckpointer(): SqliteSaver {
  if (!_saver) {
    _saver = SqliteSaver.fromConnString(CHECKPOINT_PATH);
  }
  return _saver;
}
