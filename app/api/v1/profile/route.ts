import { NextRequest, NextResponse } from "next/server";
import { getUserProfile, upsertUserProfile } from "@/lib/stores/user-profile";

export function GET() {
  const profile = getUserProfile();
  if (!profile) {
    return NextResponse.json({ id: "me", name: "", icon: null, about: "", created_at: "", updated_at: "" });
  }
  return NextResponse.json(profile);
}

export async function PUT(req: NextRequest) {
  const body = await req.json() as { name?: string; icon?: string | null; about?: string };
  const existing = getUserProfile();
  const row = upsertUserProfile(
    body.name ?? existing?.name ?? "",
    "icon" in body ? (body.icon ?? null) : (existing?.icon ?? null),
    body.about ?? existing?.about ?? "",
  );
  return NextResponse.json(row);
}
