import { NextResponse } from "next/server";
import {
  getPackagesDir,
  reloadLangChainPackages,
} from "@/lib/tools/packages/langchain-packages";
import { listDefaultPackages, reloadDefaultPackages } from "@/lib/tools/packages/default-packages";

export async function POST() {
  const result = await reloadLangChainPackages();
  reloadDefaultPackages();
  return NextResponse.json({
    packagesDir: getPackagesDir(),
    registered: result.registered,
    skipped: result.skipped,
    errors: result.errors,
    defaults: listDefaultPackages(),
  });
}
