import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getUserProfile,
  setLocationConsent,
  updateUserLocation,
} from "@/lib/stores/user-profile";

// Body for POST: upsert the latest coordinates from the browser.
// Requires location_consent === 1 server-side; otherwise rejected.
const PostBody = z.object({
  lat: z.number().finite().gte(-90).lte(90),
  lng: z.number().finite().gte(-180).lte(180),
  accuracy_m: z.number().finite().nonnegative().optional().nullable(),
  label: z.string().max(200).optional().nullable(),
});

// Body for PUT: toggle the consent flag (independent of having coords).
const PutBody = z.object({
  consent: z.boolean(),
});

export async function POST(req: NextRequest) {
  let parsed: z.infer<typeof PostBody>;
  try {
    parsed = PostBody.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: "invalid body", detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
  try {
    const row = updateUserLocation(parsed);
    return NextResponse.json(row);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 409 },
    );
  }
}

export async function PUT(req: NextRequest) {
  let parsed: z.infer<typeof PutBody>;
  try {
    parsed = PutBody.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: "invalid body", detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
  const row = setLocationConsent(parsed.consent);
  return NextResponse.json(row);
}

// DELETE = revoke consent and wipe stored coordinates.
export function DELETE() {
  const row = setLocationConsent(false);
  return NextResponse.json(row);
}

export function GET() {
  return NextResponse.json(getUserProfile());
}
