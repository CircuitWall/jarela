import { NextResponse } from "next/server";
import {
  getPackagesDir,
  loadLangChainPackages,
} from "@/lib/tools/langchain-packages";

export async function GET() {
  const result = await loadLangChainPackages();
  return NextResponse.json({
    packagesDir: getPackagesDir(),
    registered: result.registered,
    skipped: result.skipped,
    errors: result.errors,
  });
}
