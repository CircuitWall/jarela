// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { defaultDocumentRecallPolicy } from "@/lib/documents/recall-policy";
import type { DocumentSource } from "@/api/types";

const mocks = vi.hoisted(() => ({
  recall: vi.fn(), sources: vi.fn(), integrations: vi.fn(),
  create: vi.fn(), update: vi.fn(), reindex: vi.fn(), confirm: vi.fn(),
}));
vi.mock("@/api/client", () => ({
  api: {
    documents: {
      getRecallPolicy: mocks.recall, listSources: mocks.sources,
      createSource: mocks.create, updateSource: mocks.update, reindex: mocks.reindex,
    },
    integrations: { list: mocks.integrations },
  },
}));
vi.mock("@/lib/ui/confirm", () => ({ confirmAction: mocks.confirm }));
vi.mock("@/lib/ui/toasts", () => ({ pushToast: vi.fn() }));
const { useDocumentsPanel } = await import("./useDocumentsPanel");
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.recall.mockResolvedValue({ policy: defaultDocumentRecallPolicy(), local_embeddings: false });
  mocks.sources.mockResolvedValue([]);
  mocks.integrations.mockResolvedValue({ statuses: [{ name: "gmail", configured: true }] });
  mocks.confirm.mockResolvedValue(false);
  mocks.create.mockResolvedValue({});
  mocks.update.mockResolvedValue({});
  mocks.reindex.mockResolvedValue({ stats: { scanned: 0, added: 0, updated: 0 } });
});

async function panel() {
  const hook = renderHook(() => useDocumentsPanel());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

describe("nonlocal indexing disclosure", () => {
  it("cancellation prevents creation, reindexing, and source re-enabling", async () => {
    const { result } = await panel();
    const source: DocumentSource = {
      id: "source-1", path: "gmail-mail://synthetic", label: "Mail", enabled: false,
      last_scan_at: null, last_error: null, created_at: "", updated_at: "",
      kind: "gmail_mail", config: { query: "newer_than:90d" },
      stats: { source_id: "source-1", document_count: 0, chunk_count: 0, embedded_chunk_count: 0 },
    };
    await act(async () => {
      expect(await result.current.addSource({ path: "C:\\synthetic-documents" })).toBe(false);
      await result.current.reindex("source-1");
      await result.current.toggleSource(source);
    });
    expect(mocks.confirm).toHaveBeenCalledTimes(3);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.reindex).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("allows creation after explicit confirmation", async () => {
    mocks.confirm.mockResolvedValue(true);
    const { result } = await panel();
    await act(async () => {
      expect(await result.current.addSource({ path: "C:\\synthetic-documents" })).toBe(true);
    });
    expect(mocks.create).toHaveBeenCalledWith({ path: "C:\\synthetic-documents" });
  });

  it("does not prompt for local indexing", async () => {
    mocks.recall.mockResolvedValue({ policy: defaultDocumentRecallPolicy(), local_embeddings: true });
    const { result } = await panel();
    await act(async () => { await result.current.addSource({ path: "C:\\synthetic-documents" }); });
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it("does not start indexing if the provider status cannot be checked", async () => {
    const { result } = await panel();
    mocks.recall.mockRejectedValue(new Error("Settings unavailable"));
    await act(async () => {
      await expect(result.current.addSource({ path: "C:\\synthetic-documents" })).rejects.toThrow("Settings unavailable");
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(result.current.error).toBe("Settings unavailable");
  });
});
