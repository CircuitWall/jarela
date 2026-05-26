import { NextRequest, NextResponse, after } from "next/server";
import { getWatcher } from "@/lib/stores/watchers";
import { runWatcherFiringNow } from "@/lib/triggers";

type Params = { params: Promise<{ id: string }> };

// Force a single poll of the watcher. If the result differs from the
// last fingerprint, the agent fires; otherwise the watcher state is
// updated silently. Returns 202 immediately — progress + completion
// notifications flow through the events bus like scheduled tasks.
export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const watcher = getWatcher(id);
  if (!watcher) return NextResponse.json({ error: "not found" }, { status: 404 });
  after(async () => {
    try {
      await runWatcherFiringNow(id);
    } catch (err) {
      console.error(`[watchers/${id}/run] after() failed:`, err);
    }
  });
  return NextResponse.json({ accepted: true, watcher_id: id }, { status: 202 });
}
