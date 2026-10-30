import { NextResponse, type NextRequest } from "next/server";
import { homedir } from "node:os";
import { importServerJson, searchUpstream } from "@/lib/mcp/upstream-registry";
import type { RegistryEntry } from "@/lib/mcp/registry";
import { errorMessage } from "@/lib/utils/error";
import { errorResponse, validateBody, errorJson } from "@/lib/api/responses";
import { z } from "zod";

const ImportBody = z.object({
  manifest: z.string().min(1, "Paste a server.json manifest.").max(1_000_000, "Manifest must be 1 MB or smaller."),
});

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
  // `curated=0` opts the user out of the curated allowlist and falls back
  // to the broader Official + Vendor view. Default behaviour (parameter
  // absent OR `curated=1`) honours `JARELA_MCP_CURATED_ONLY` for operators.
  const curatedParam = searchParams.get("curated");
  const envCuratedDefault = process.env.JARELA_MCP_CURATED_ONLY !== "0";
  const curatedOnly =
    curatedParam === null ? envCuratedDefault : curatedParam !== "0";

  try {
    const { entries, nextCursor } = await searchUpstream({
      q,
      cursor,
      limit,
      fresh,
      curatedOnly,
    });
    return NextResponse.json({ entries: entries.map(expandHome), nextCursor });
  } catch (err) {
    return errorJson({ error: "registry-unreachable", detail: errorMessage(err) }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const body = await validateBody(req, ImportBody);
  if (body instanceof NextResponse) return body;
  let manifest: unknown;
  try {
    manifest = JSON.parse(body.manifest);
  } catch {
    return errorResponse("The pasted server.json is not valid JSON.", 400);
  }
  try {
    return NextResponse.json({ entry: importServerJson(manifest) });
  } catch (err) {
    return errorResponse(errorMessage(err), 400);
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
