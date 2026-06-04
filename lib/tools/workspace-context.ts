// Per-thread workspace context for software-development agents.
//
// `workspace_init` registers a project root for the active thread; from
// then on, every `file_*` and `local_exec` call with a relative path
// resolves against that root instead of the user's HOME directory.
//
// State lives on globalThis under a Symbol so multiple module instances
// (Next.js route bundles, dev HMR) share the same map. Same idempotency
// pattern as lib/logging/sink.ts.
//
// Tools read the active workspace by passing the langchain tool config
// through to `currentWorkspace(config)`. The config carries
// `configurable.thread_id` set by the agent runner; tools invoked
// outside a thread (live tests, ad-hoc CLI use) fall through to the
// "_default" slot.

export interface WorkspaceContext {
  root: string;
  scoped: boolean;
  /** Set when initialised; useful for status output. */
  opened_at: number;
}

const STATE_KEY: unique symbol = Symbol.for("@jarela/workspace-context");
type GlobalWithWorkspace = typeof globalThis & {
  [STATE_KEY]?: Map<string, WorkspaceContext>;
};

function store(): Map<string, WorkspaceContext> {
  const g = globalThis as GlobalWithWorkspace;
  if (!g[STATE_KEY]) g[STATE_KEY] = new Map();
  return g[STATE_KEY]!;
}

const DEFAULT_KEY = "_default";

/** Langchain tool config shape (only the parts we care about). */
export interface ToolConfig {
  configurable?: {
    thread_id?: string;
    [k: string]: unknown;
  };
}

function keyFor(config?: ToolConfig): string {
  const tid = config?.configurable?.thread_id;
  return typeof tid === "string" && tid ? tid : DEFAULT_KEY;
}

export function currentWorkspace(config?: ToolConfig): WorkspaceContext | undefined {
  return store().get(keyFor(config));
}

export function setWorkspace(ws: WorkspaceContext, config?: ToolConfig): void {
  store().set(keyFor(config), ws);
}

export function clearWorkspace(config?: ToolConfig): boolean {
  return store().delete(keyFor(config));
}

/** Test-only: wipe every registered workspace. */
export function _resetWorkspaceContext(): void {
  store().clear();
}
