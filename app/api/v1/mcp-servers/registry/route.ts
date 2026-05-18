import { NextResponse } from "next/server";
import { homedir } from "node:os";
import { MCP_REGISTRY } from "@/lib/mcp/registry";

// Expand ${HOME} in variable defaults so registry entries can ship a
// portable path (e.g. `${HOME}/.jarela/external/...`) and have the
// picker form pre-fill with the user's actual home directory.
export function GET() {
  const home = homedir();
  const expanded = MCP_REGISTRY.map((entry) =>
    entry.variables
      ? {
          ...entry,
          variables: entry.variables.map((v) =>
            v.default
              ? { ...v, default: v.default.replace(/\$\{HOME\}/g, home) }
              : v,
          ),
        }
      : entry,
  );
  return NextResponse.json(expanded);
}
