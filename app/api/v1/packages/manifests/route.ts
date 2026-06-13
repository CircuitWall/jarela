import { NextRequest, NextResponse } from "next/server";
import { errorResponse, validateBody } from "@/lib/api/responses";
import {
  createManifest,
  listManifests,
  MANIFEST_INPUT_SCHEMA,
} from "@/lib/tools/package-manifests";
import { errorMessage } from "@/lib/utils/error";

export function GET() {
  return NextResponse.json(listManifests());
}

export async function POST(req: NextRequest) {
  const parsed = await validateBody(req, MANIFEST_INPUT_SCHEMA);
  if (parsed instanceof NextResponse) return parsed;
  try {
    const result = await createManifest(parsed);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = errorMessage(err);
    const status = msg.includes("already exists") ? 409 : 400;
    return errorResponse(msg, status);
  }
}
