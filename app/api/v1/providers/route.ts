import { NextResponse } from "next/server";
import { listProviderNames } from "@/lib/providers";

export async function GET() {
  return NextResponse.json(listProviderNames());
}
