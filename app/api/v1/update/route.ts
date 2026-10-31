import { NextResponse } from "next/server";
import { checkForUpdate } from "@/lib/lifecycle/update-check";
import { getCurrentVersion } from "@/lib/lifecycle/version";

export const dynamic = "force-dynamic";

export async function GET() {
  const info = await checkForUpdate({
    current: getCurrentVersion(),
    packageRoot: process.cwd(),
  });
  return NextResponse.json(info);
}
