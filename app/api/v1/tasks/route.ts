import { cachedJson } from "@/lib/api/responses";
import { listTaskAssignments } from "@/lib/stores/task-assignments";

export function GET() {
  return cachedJson(listTaskAssignments(), 15);
}
