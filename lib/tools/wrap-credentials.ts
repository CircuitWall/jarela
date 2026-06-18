// Wraps a list of LangChain tools so each invocation enters an
// AsyncLocalStorage frame describing the currently-running tool name and
// the agent's per-tool credential overrides. The integrations store
// (`getIntegrationRaw`) reads that frame to pick the right credential
// when more than one is configured for a given provider.
//
// Mirrors the Proxy-based approach used by
// `lib/redaction/wrap-tools.ts` so we don't touch the underlying tool's
// prototype chain — LangChain's instanceof checks (and any extra
// properties the package surfaces) flow through unchanged.

import type { StructuredToolInterface } from "@langchain/core/tools";
import { runWithToolCredentialContext } from "@/lib/tools/credential-context";

export function wrapToolForCredentialRouting(
  tool: StructuredToolInterface,
  toolCredentials: Readonly<Record<string, string>>,
): StructuredToolInterface {
  return new Proxy(tool, {
    get(target, prop, receiver) {
      if (prop === "invoke") {
        const orig = target.invoke.bind(target);
        return (input: unknown, options?: unknown) =>
          runWithToolCredentialContext(
            { toolName: target.name, toolCredentials },
            () => orig(
              input as Parameters<typeof orig>[0],
              options as Parameters<typeof orig>[1],
            ),
          );
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function wrapToolsForCredentialRouting(
  tools: StructuredToolInterface[],
  toolCredentials: Readonly<Record<string, string>>,
): StructuredToolInterface[] {
  // Empty override map is the common case — skip the proxy layer entirely
  // so the resolver fast-path through `getIntegrationRaw` stays a single
  // ALS lookup that returns null.
  if (!toolCredentials || Object.keys(toolCredentials).length === 0) return tools;
  return tools.map((t) => wrapToolForCredentialRouting(t, toolCredentials));
}
