import { NextRequest, NextResponse } from "next/server";
import { deleteIntegration, getIntegrationStatus, saveIntegration } from "@/lib/stores/integrations";

type Params = { params: Promise<{ name: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { name } = await params;
  const status = getIntegrationStatus(name);
  if (!status) return NextResponse.json({ error: "unknown integration" }, { status: 404 });
  return NextResponse.json(status);
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { name } = await params;
  const body = (await req.json()) as Record<string, string>;
  const result = saveIntegration(name, body);
  if ("error" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { name } = await params;
  const ok = deleteIntegration(name);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
