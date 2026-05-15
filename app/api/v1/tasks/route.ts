import { NextResponse } from "next/server";
import { listTaskAssignments } from "@/lib/stores/task-assignments";

export function GET() {
  return NextResponse.json(listTaskAssignments());
}
