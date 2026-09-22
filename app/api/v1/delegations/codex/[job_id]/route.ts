import { NextResponse } from "next/server";
import { cancelJob } from "@/lib/tools/delegation/claude-delegate-jobs";
import { getCodexDelegateJobStatus } from "@/lib/tools/delegation/codex-delegate-status";

type Params = { params: Promise<{ job_id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { job_id } = await params;
  const status = getCodexDelegateJobStatus(job_id);
  if (!status) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(status);
}

export async function DELETE(_req: Request, { params }: Params) {
  const { job_id } = await params;
  if (!cancelJob(job_id, "codex")) return NextResponse.json({ error: "No running job" }, { status: 404 });
  return NextResponse.json(getCodexDelegateJobStatus(job_id));
}