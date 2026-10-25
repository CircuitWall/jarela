import { NextRequest, NextResponse } from "next/server";
import { validateBody, noStoreJson } from "@/lib/api/responses";
import { DocumentRecallPolicySchema } from "@/lib/documents/recall-policy";
import { getDocumentRecallPolicy, setDocumentRecallPolicy, isLocalEmbeddingsEnabled } from "@/lib/stores/app-settings";

export async function GET() {
  return noStoreJson({
    policy: getDocumentRecallPolicy(),
    local_embeddings: isLocalEmbeddingsEnabled(),
  });
}

export async function PUT(req: NextRequest) {
  const parsed = await validateBody(req, DocumentRecallPolicySchema);
  if (parsed instanceof NextResponse) return parsed;
  return noStoreJson({
    policy: setDocumentRecallPolicy(parsed),
    local_embeddings: isLocalEmbeddingsEnabled(),
  });
}
