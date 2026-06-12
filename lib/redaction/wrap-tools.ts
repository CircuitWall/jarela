// Tool wrapper that rehydrates «SECRET:...» placeholders in tool input
// before delegating to the real tool. The model emits the placeholder
// (it never saw the real value), the placeholder is rehydrated against
// the current MaskRunContext, and the wrapped tool runs with the
// original value. This is the load-bearing piece that lets agents
// compose with values they can't see (the "put this key in an email"
// flow described in ADR-0064).

import type { StructuredToolInterface } from "@langchain/core/tools";
import { getCurrentMaskContext } from "./context";

function rehydrateValue(v: unknown): unknown {
  const ctx = getCurrentMaskContext();
  if (!ctx) return v;
  return walk(v);

  function walk(x: unknown): unknown {
    if (typeof x === "string") return ctx!.rehydrate(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
        out[k] = walk(val);
      }
      return out;
    }
    return x;
  }
}

// Wrap a single tool. Uses a Proxy so the wrapped object preserves the
// prototype chain (LangChain's instanceof checks pass) and we only
// intercept `invoke`. Everything else (name, description, schema, the
// tool's own internal references) flows through unchanged.
export function wrapToolForRehydrate(
  tool: StructuredToolInterface,
): StructuredToolInterface {
  return new Proxy(tool, {
    get(target, prop, receiver) {
      if (prop === "invoke") {
        const orig = target.invoke.bind(target);
        return async (input: unknown, options?: unknown) => {
          const rehydrated = rehydrateValue(input);
          return orig(
            rehydrated as Parameters<typeof orig>[0],
            options as Parameters<typeof orig>[1],
          );
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function wrapToolsForRehydrate(
  tools: StructuredToolInterface[],
): StructuredToolInterface[] {
  return tools.map(wrapToolForRehydrate);
}
