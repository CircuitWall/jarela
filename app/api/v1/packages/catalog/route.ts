import { NextResponse } from "next/server";
import { getLangChainCatalog } from "@/lib/tools/langchain-catalog";

// Static curated catalog of well-known LangChain tool packages. Lets the
// UI render a picker so users don't have to hunt npm for the right
// package name / export / env vars.
export function GET() {
  return NextResponse.json({ entries: getLangChainCatalog() });
}
