export type ToolPermissionKind = "read" | "write" | "execute";

const READ_PREFIXES = ["get_", "list_", "search_", "read_", "fetch_", "check_", "status_"];
const WRITE_PREFIXES = [
  "create_", "update_", "delete_", "write_", "edit_", "modify_", "move_", "copy_", "mkdir_",
  "set_", "add_", "remove_", "trash_", "cancel_", "upsert_", "transition_", "upload_",
];
const EXECUTE_PREFIXES = ["run_", "exec_", "execute_", "shell_", "script_", "schedule_", "generate_", "trigger_", "propose_"];

export function permissionKindForTool(name: string, category?: string): ToolPermissionKind {
  const n = name.toLowerCase();
  if (READ_PREFIXES.some((p) => n.startsWith(p))) return "read";
  if (WRITE_PREFIXES.some((p) => n.startsWith(p))) return "write";
  if (category === "Shell") return "execute";
  if (EXECUTE_PREFIXES.some((p) => n.startsWith(p))) return "execute";
  return "execute";
}

export function toolScoreClass(score: number): string {
  if (score >= 0.75) {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (score >= 0.5) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300";
}
