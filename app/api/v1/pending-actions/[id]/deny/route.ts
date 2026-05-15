import { NextRequest, NextResponse } from "next/server";
import { getPendingAction, setActionStatus } from "@/lib/stores/pending-actions";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const action = getPendingAction(id);
  if (!action) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (action.status !== "pending") {
    return NextResponse.json({ error: `already ${action.status}` }, { status: 409 });
  }
  const final = setActionStatus(id, "denied", "user denied");
  return NextResponse.json(final);
}
