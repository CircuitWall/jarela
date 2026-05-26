import { NextRequest, NextResponse } from "next/server";
import { getDocumentSource } from "@/lib/stores/document-sources";
import { indexSource } from "@/lib/documents/indexer";
import { isRemoteKind, runRemoteSource } from "@/lib/documents/remote";

type Params = { params: Promise<{ id: string }> };

// Force-reindex one source. Local folders use a higher per-call file cap
// than the background sweep so the user gets a complete result in one
// click — but it's still bounded so a misconfigured root (e.g. /) can't
// hang the request indefinitely. Remote kinds (ADR-0026) delegate to
// runRemoteSource which already has its own per-run caps.
export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const source = getDocumentSource(id);
  if (!source) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const stats = isRemoteKind(source.kind)
      ? await runRemoteSource(source)
      : await indexSource(source, { maxFiles: 5000 });
    return NextResponse.json({ source_id: id, stats });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
