import { NextResponse } from "next/server";
import { listBridgeModules } from "@/lib/bridges/registry";

export function GET() {
  return NextResponse.json(listBridgeModules());
}