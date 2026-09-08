/**
 * Tools that stay executable regardless of category toggles.
 *
 * Since non-basic tools are reached only through the proxy, disabling the
 * `Config` category would otherwise sever an agent's access to every
 * integration at once. These two are structural plumbing, not a capability
 * an operator means to revoke.
 */
export const ALWAYS_ON_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_tools",
  "invoke_tool",
]);

export function isAlwaysOnTool(name: string): boolean {
  return ALWAYS_ON_TOOL_NAMES.has(name);
}
