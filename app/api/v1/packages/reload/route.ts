import { NextResponse } from "next/server";
import {
  getPackagesDir,
  reloadLangChainPackages,
} from "@/lib/tools/langchain-packages";

export async function POST() {
  const result = await reloadLangChainPackages();
  return NextResponse.json({
    packagesDir: getPackagesDir(),
    registered: result.registered,
    skipped: result.skipped,
    errors: result.errors,
  });
}
