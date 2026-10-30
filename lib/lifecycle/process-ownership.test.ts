import { describe, expect, it, vi } from "vitest";
import { currentProcessOwner, isProcessOwnerDead } from "./process-ownership";

describe("process ownership identity", () => {
  it("returns a stable process UUID without exposing a mutable shared identity", () => {
    const first = currentProcessOwner();
    const second = currentProcessOwner();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    first.instanceId = "changed";
    expect(currentProcessOwner()).toEqual(second);
  });

  it("rejects malformed, same-PID and unverifiable ownership without guessing death", async () => {
    const kill = vi.spyOn(process, "kill");
    expect(await isProcessOwnerDead({ pid: -1, instanceId: "invalid" })).toBe(false);
    expect(await isProcessOwnerDead(currentProcessOwner())).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    kill.mockImplementation(() => { throw Object.assign(new Error("unknown"), { code: "EINVAL" }); });
    expect(await isProcessOwnerDead({ ...currentProcessOwner(), pid: process.pid + 1 })).toBe(false);
    kill.mockRestore();
  });
});
