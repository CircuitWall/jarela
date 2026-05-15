import { NextResponse } from "next/server";
import { removeFromWhitelist } from "@/lib/stores/access";

type Params = { params: Promise<{ identity: string }> };

export async function DELETE(_req: Request, { params }: Params) {
  const { identity } = await params;
  removeFromWhitelist(decodeURIComponent(identity));
  return NextResponse.json({ deleted: true });
}
