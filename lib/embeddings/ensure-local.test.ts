import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureTarget: vi.fn(),
  getEnsureOutcome: vi.fn(),
  getLocalModelStatus: vi.fn(),
  startLocalModelDownload: vi.fn(),
}));

vi.mock("@/lib/dependencies/ensure", () => ({
  ensureTarget: mocks.ensureTarget,
  getEnsureOutcome: mocks.getEnsureOutcome,
}));
vi.mock("./local-model", () => ({
  getLocalModelStatus: mocks.getLocalModelStatus,
  startLocalModelDownload: mocks.startLocalModelDownload,
}));

const { ensureLocalEmbeddings, getLocalEmbeddingsReadiness, LOCAL_EMBEDDINGS_RUNTIME } =
  await import("./ensure-local");

const runtimeReady = {
  target: { kind: "runtime", id: LOCAL_EMBEDDINGS_RUNTIME },
  status: "installed",
  message: "Installed the dependencies for runtime:@huggingface/transformers.",
  install: null,
  missing: [],
  checked_at: "now",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEnsureOutcome.mockReturnValue(null);
  mocks.getLocalModelStatus.mockReturnValue({ state: "missing", totalBytes: 1 });
  mocks.startLocalModelDownload.mockResolvedValue("models/");
});

describe("ensureLocalEmbeddings", () => {
  it("installs the runtime, then downloads the model", async () => {
    mocks.ensureTarget.mockResolvedValue(runtimeReady);
    mocks.getEnsureOutcome.mockReturnValue(runtimeReady);
    mocks.getLocalModelStatus
      .mockReturnValueOnce({ state: "missing", totalBytes: 1 })
      .mockReturnValue({ state: "ready", source: "bundled", totalBytes: 1 });

    const readiness = await ensureLocalEmbeddings();

    expect(mocks.ensureTarget).toHaveBeenCalledWith(
      { kind: "runtime", id: LOCAL_EMBEDDINGS_RUNTIME },
      {},
    );
    expect(mocks.startLocalModelDownload).toHaveBeenCalledOnce();
    expect(readiness).toMatchObject({ ready: true, runtime_installed: true });
  });

  it("does not start the model download when the runtime is missing", async () => {
    mocks.ensureTarget.mockResolvedValue({ ...runtimeReady, status: "pending_approval", message: "needs approval" });
    mocks.getEnsureOutcome.mockReturnValue({ ...runtimeReady, status: "pending_approval", message: "needs approval" });

    const readiness = await ensureLocalEmbeddings();

    expect(mocks.startLocalModelDownload).not.toHaveBeenCalled();
    expect(readiness).toMatchObject({ ready: false, runtime_installed: false, message: "needs approval" });
  });

  it("surfaces a failed model download instead of claiming readiness", async () => {
    mocks.ensureTarget.mockResolvedValue(runtimeReady);
    mocks.getEnsureOutcome.mockReturnValue(runtimeReady);
    mocks.startLocalModelDownload.mockRejectedValue(new Error("offline"));
    mocks.getLocalModelStatus.mockReturnValue({ state: "failed", totalBytes: 1, error: "download failed" });

    const readiness = await ensureLocalEmbeddings();

    expect(readiness).toMatchObject({ ready: false, message: "download failed" });
  });

  it("reports progress before the first attempt", () => {
    expect(getLocalEmbeddingsReadiness()).toMatchObject({
      ready: false,
      runtime: null,
      runtime_installed: false,
    });
  });
});
