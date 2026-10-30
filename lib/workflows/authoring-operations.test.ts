import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  extension: { inspectOperation: vi.fn(), approve: vi.fn(), close: vi.fn() },
  contribution: { inspectOperation: vi.fn(), approve: vi.fn(), close: vi.fn() },
}));
vi.mock("./extension-service", () => ({ extensionService: () => services.extension }));
vi.mock("./contribution-service", () => ({ contributionService: () => services.contribution }));
import { approveAuthoringOperation, shutdownAuthoringOperations } from "./authoring-operations";

const id = "00000000-0000-4000-8000-000000000001";
const proposal = "00000000-0000-4000-8000-000000000002";
const payload = { operation_id: id, operation_type: "extension", stage: "test", revision: "a".repeat(64) };
const preview = { ...payload, proposal_id: proposal, status: "pending" };
beforeEach(() => { vi.resetAllMocks(); });
describe("trusted authoring approval dispatcher", () => {
  it("binds the reserved agent/proposal/stage/revision and stores metadata, never local source", async () => {
    services.extension.inspectOperation.mockReturnValue(preview);
    services.extension.approve.mockResolvedValue({ ...preview, status: "succeeded", files: ["synthetic-local-source"], output: { diff: "synthetic-local-diff" } });
    const observed = await approveAuthoringOperation(payload, "owning-agent", proposal);
    expect(services.extension.inspectOperation).toHaveBeenCalledWith(id, "owning-agent");
    expect(services.extension.approve).toHaveBeenCalledWith(id, "owning-agent");
    expect(observed).toMatchObject({ stage: "test", status: "succeeded", proposal_id: proposal });
    expect(JSON.stringify(observed)).not.toContain("synthetic-local");
  });
  it("refuses a changed review or copied pending identity before execution", async () => {
    services.extension.inspectOperation.mockReturnValue(preview);
    for (const [body, pendingId] of [
      [{ ...payload, stage: "install" }, proposal],
      [{ ...payload, revision: "b".repeat(64) }, proposal],
      [payload, "00000000-0000-4000-8000-000000000003"],
    ] as const) {
      await expect(approveAuthoringOperation(body, "owning-agent", pendingId)).rejects.toThrow(/exact stage and revision/);
    }
    expect(services.extension.approve).not.toHaveBeenCalled();
  });
  it("does not return shutdown failure until every other underlying owner settles", async () => {
    services.extension.close.mockRejectedValue(new Error("Synthetic close failure"));
    let finish!: () => void;
    services.contribution.close.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    let settled = false;
    const closing = shutdownAuthoringOperations().finally(() => { settled = true; });
    await vi.waitFor(() => expect(services.contribution.close).toHaveBeenCalled());
    expect(settled).toBe(false);
    finish();
    await expect(closing).rejects.toThrow("after all owners settled");
  });
});
