// Per-tool metadata that isn't part of the LangChain tool contract itself
// (name/description/schema/func) but that this app's own wrapper layer
// (wallclock.ts) needs. Declared by the tool's own module, right at its
// `tool(...)` call site, instead of listed in a central registry — adding
// a new streaming-by-default tool never requires touching wallclock.ts.
//
// A WeakMap keyed by the tool object itself (not its name) so this stays
// exact — no risk of a name string typo silently matching nothing, and no
// risk of two unrelated tools colliding on the same name across modules.

import type { StructuredToolInterface } from "@langchain/core/tools";

const streamDefaults = new WeakMap<StructuredToolInterface, boolean>();

/**
 * Declare whether this tool's live progress (see reportToolProgress in
 * workspace-context.ts) should reach the UI by default. Call once, right
 * around `tool(...)`, in the tool's own file:
 *
 *   export const myTool = withStreamDefault(tool(...), true);
 *
 * Tools that never call this default to false (most tools finish too
 * fast for a live trace to matter). The calling agent can still override
 * either way for a single call via the `stream` arg wrapWithWallclock
 * injects into every tool's schema.
 */
export function withStreamDefault<T extends StructuredToolInterface>(t: T, streamByDefault: boolean): T {
  streamDefaults.set(t, streamByDefault);
  return t;
}

/** @internal — read by wallclock.ts. Defaults to false when undeclared. */
export function getStreamDefault(t: StructuredToolInterface): boolean {
  return streamDefaults.get(t) ?? false;
}
