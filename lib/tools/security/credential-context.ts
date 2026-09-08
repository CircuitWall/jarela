// Per-tool credential routing context.
//
// LangChain tool packages register a single `setAuthResolver()` callback per
// integration. That resolver is a process-wide singleton — at call time it
// has no idea WHICH agent or WHICH tool name triggered it, so it can only
// return one credential per integration. That's fine for the single-instance
// case, but breaks the moment a user has e.g. two Gmail credentials and
// wants different tools to use different ones.
//
// We fix that with an AsyncLocalStorage frame that the tool wrapper enters
// just before delegating to the underlying tool. The frame carries
//
//   - `toolName`        — name of the tool currently being invoked
//   - `toolCredentials` — the active agent's `{ toolName: credentialId }`
//                         override map (empty/missing = no overrides)
//
// `lib/stores/integrations.getIntegrationRaw()` reads the frame to decide
// whether to load the explicit override credential or fall back to the
// integration's default credential.

import { AsyncLocalStorage } from "node:async_hooks";

export interface ToolCredentialContext {
  toolName: string;
  toolCredentials: Readonly<Record<string, string>>;
}

const storage = new AsyncLocalStorage<ToolCredentialContext>();

/**
 * Runs `fn` with the given context attached. Async callees observe it via
 * `getCurrentToolCredentialContext()`. The frame is local to the async
 * chain — concurrent runs see their own context.
 */
export function runWithToolCredentialContext<T>(
  ctx: ToolCredentialContext,
  fn: () => T,
): T {
  return storage.run(ctx, fn);
}

/**
 * Reads the context attached to the current async chain. Returns `null`
 * outside any wrapped invocation (e.g. when an integration tool is called
 * synchronously from a script or test fixture without going through the
 * agent runtime).
 */
export function getCurrentToolCredentialContext(): ToolCredentialContext | null {
  return storage.getStore() ?? null;
}
