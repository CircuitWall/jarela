import { afterEach, describe, expect, it } from "vitest";
import { DELETE, GET } from "@/app/api/v1/delegations/codex/[job_id]/route";
import * as jobs from "@/lib/tools/delegation/claude-delegate-jobs";

afterEach(() => jobs._resetDelegateJobs());

function params(job_id: string) {
  return { params: Promise.resolve({ job_id }) };
}

describe("Codex delegate job route", () => {
  it("returns the live job transcript", async () => {
    jobs.createJob("job-1", {
      provider: "codex",
      projectKey: "/tmp/project",
      sessionId: "thread-1",
      parentMessage: "Fix the test",
      resumed: false,
    });
    jobs.appendStep("job-1", "→ npm test");

    const response = await GET(new Request("http://local/api/v1/delegations/codex/job-1"), params("job-1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      job_id: "job-1",
      status: "running",
      transcript: { provider: "Codex", steps: ["→ npm test"] },
    });
  });

  it("cancels a running job and rejects a second cancellation", async () => {
    jobs.createJob("job-1", {
      provider: "codex",
      projectKey: "/tmp/project",
      sessionId: "thread-1",
      parentMessage: "Fix the test",
      resumed: false,
    });

    const cancelled = await DELETE(new Request("http://local/api/v1/delegations/codex/job-1", { method: "DELETE" }), params("job-1"));
    const second = await DELETE(new Request("http://local/api/v1/delegations/codex/job-1", { method: "DELETE" }), params("job-1"));

    await expect(cancelled.json()).resolves.toMatchObject({ status: "cancelled" });
    expect(second.status).toBe(404);
  });

  it("treats a claude_delegate job as not found through the codex route", async () => {
    jobs.createJob("job-1", {
      provider: "claude",
      projectKey: "/tmp/project",
      sessionId: "thread-1",
      parentMessage: "Fix the test",
      resumed: false,
    });

    const getResponse = await GET(new Request("http://local/api/v1/delegations/codex/job-1"), params("job-1"));
    expect(getResponse.status).toBe(404);

    const deleteResponse = await DELETE(new Request("http://local/api/v1/delegations/codex/job-1", { method: "DELETE" }), params("job-1"));
    expect(deleteResponse.status).toBe(404);
  });
});