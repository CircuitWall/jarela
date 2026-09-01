import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getUserProfile, upsertUserProfile, setUserPreset } from "@/lib/stores/user-profile";
import { validateBody } from "@/lib/api/responses";

const PutBody = z.object({
  name: z.string().optional(),
  icon: z.string().nullable().optional(),
  about: z.string().optional(),
  // Validated at the boundary so an invalid preset rejects the request
  // before any part of the profile is written.
  preset: z.enum(["home", "work", "dev", "custom"], {
    message: "preset must be one of: home, work, dev, custom, null",
  }).nullable().optional(),
});

export function GET() {
  const profile = getUserProfile();
  if (!profile) {
    return NextResponse.json({ id: "me", name: "", icon: null, about: "", created_at: "", updated_at: "", preset: null });
  }
  return NextResponse.json(profile);
}

export async function PUT(req: NextRequest) {
  const body = await validateBody(req, PutBody);
  if (body instanceof NextResponse) return body;
  // Preset is an opt-in additional field; only touch the column when the
  // caller explicitly sent it (so older clients that PUT name/icon/about
  // don't accidentally clear a previously-chosen preset).
  const hasPreset = "preset" in body;

  const existing = getUserProfile();
  const row = upsertUserProfile(
    body.name ?? existing?.name ?? "",
    "icon" in body ? (body.icon ?? null) : (existing?.icon ?? null),
    body.about ?? existing?.about ?? "",
  );
  if (hasPreset) {
    return NextResponse.json(setUserPreset(body.preset ?? null));
  }
  return NextResponse.json(row);
}

