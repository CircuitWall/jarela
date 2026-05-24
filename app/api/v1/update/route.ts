import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { checkForUpdate } from "@/lib/lifecycle/update-check";

export const dynamic = "force-dynamic";

function getCurrentVersion(): string {
  try {
    // In the standalone build package.json sits at the bundle root, which is
    // also the process cwd at start-prod time.
    const raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function GET() {
  const info = await checkForUpdate({
    current: getCurrentVersion(),
    packageRoot: process.cwd(),
  });
  return NextResponse.json(info);
}
