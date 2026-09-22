import { afterEach, describe, expect, it } from "vitest";
import * as jobs from "./claude-delegate-jobs";
import { getCodexDelegateJobStatus } from "./codex-delegate-status";

afterEach(() => jobs._resetDelegateJobs());

describe("getCodexDelegateJobStatus", () => {
  it("returns live progress and the session assigned after a new run starts", () => {
    jobs.createJob("job-1", {
      provider: "codex",
      projectKey: "/tmp/project",
      sessionId: "",
      parentMessage: "Fix the test",
      resumed: false,
    });
    jobs.appendStep("job-1", "→ npm test");
    jobs.setJobSession("job-1", "thread-123");

    expect(getCodexDelegateJobStatus("job-1")).toMatchObject({
      status: "running",
      session_id: "thread-123",
      steps: ["→ npm test"],
      new_steps: ["→ npm test"],
      transcript: { provider: "Codex", steps: ["→ npm test"] },
    });
  });

  it("returns null for a job created by claude_delegate", () => {
    jobs.createJob("job-1", {
      provider: "claude",
      projectKey: "/tmp/project",
      sessionId: "",
      parentMessage: "Fix the test",
      resumed: false,
    });

    expect(getCodexDelegateJobStatus("job-1")).toBeNull();
  });
});