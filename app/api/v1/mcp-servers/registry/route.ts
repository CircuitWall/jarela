import { NextResponse, type NextRequest } from "next/server";
import { homedir } from "node:os";
import { searchUpstream } from "@/lib/mcp/upstream-registry";
import type { RegistryEntry } from "@/lib/mcp/registry";
import { errorMessage } from "@/lib/utils/error";

// Proxies the official MCP registry (registry.modelcontextprotocol.io). The
// picker UI calls this with `?q=...&cursor=...` and gets back already-translated
// `RegistryEntry` records ready to drop into the install form.
//
// `${HOME}` substitution stays here so registry entries that ship default
// paths under the user's home work portably across machines.
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const q = searchParams.get("q") ?? undefined;
  const cursor = searchParams.get("cursor") ?? undefined;
  const limitParam = searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;
  const fresh = searchParams.get("fresh") === "1";

  try {
    const { entries, nextCursor } = await searchUpstream({ q, cursor, limit, fresh });
    return NextResponse.json({ entries: entries.map(expandHome), nextCursor });
  } catch (err) {
    return NextResponse.json(
      { error: "registry-unreachable", detail: errorMessage(err) },
      { status: 503 },
    );
  }
}

function expandHome(entry: RegistryEntry): RegistryEntry {
  if (!entry.variables) return entry;
  const home = homedir();
  return {
    ...entry,
    variables: entry.variables.map((v) =>
      v.default ? { ...v, default: v.default.replace(/\$\{HOME\}/g, home) } : v,
    ),
  };
}
