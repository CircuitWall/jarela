import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteIntegration, getIntegrationStatus, saveIntegration } from "@/lib/stores/integrations";
import { validateBody, errorResponse } from "@/lib/api/responses";
import { refreshExternalProviderIntegrations } from "@/lib/providers/provider-integrations";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";

type Params = { params: Promise<{ name: string }> };

const PutBody = z.record(z.string(), z.string());

export async function GET(_req: NextRequest, { params }: Params) {
  const { name } = await params;
  refreshExternalProviderIntegrations();
  const status = getIntegrationStatus(name);
  if (!status) return errorResponse("unknown integration", 404);
  return NextResponse.json(status);
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { name } = await params;
  refreshExternalProviderIntegrations();
  const body = await validateBody(req, PutBody);
  if (body instanceof NextResponse) return body;
  const result = saveIntegration(name, body);
  if ("error" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { name } = await params;
  refreshExternalProviderIntegrations();
  const ok = deleteIntegration(name);
  if (!ok) return errorResponse(NOT_FOUND_ERRORS.LEGACY, 404);
  return NextResponse.json({ deleted: true });
}
