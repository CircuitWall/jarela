import { NextResponse } from "next/server";
import { publish } from "@/lib/notifications/bus";

// Diagnostic: publish a synthetic task_completed event so we can verify the
// bus → SSE → frontend pipeline without needing the scheduler or an LLM call.
// Hitting this while a /events SSE is open should produce a toast immediately.
export function POST() {
  publish({
    type: "task_completed",
    task_id: `test-${Date.now()}`,
    agent_id: "assistant",
    prompt: "Pipeline test",
    thread_id: "",
    status: "done",
    preview: "If you see this as a toast, the pipeline is healthy.",
    ts: Date.now(),
  });
  return NextResponse.json({ published: true });
}
