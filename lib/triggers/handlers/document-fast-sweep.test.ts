import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DocumentSourceRow } from "@/lib/stores/document-sources";
import type { ScriptFiring, TriggerFiring } from "../types";

const mocks = vi.hoisted(() => ({
  enabledSources: [] as DocumentSourceRow[],
  runRemote: vi.fn(),
  markScanned: vi.fn(),
}));

vi.mock("@/lib/stores/document-sources", () => ({
  listEnabledDocumentSources: () => mocks.enabledSources,
  markSourceScanned: mocks.markScanned,
}));

vi.mock("@/lib/documents/remote", () => ({
  isRemoteKind: (k: string) => k !== "local_folder",
  runRemoteSource: mocks.runRemote,
}));

const {
  documentFastSweepHandler,
  __resetFastSweepState,
  DOCUMENT_FAST_SWEEP_KIND,
} = await import("./document-fast-sweep");

function fakeSource(id: string, kind: DocumentSourceRow["kind"]): DocumentSourceRow {
  return {
    id,
    path: `/synthetic/${id}`,
    label: null,
    enabled: 1,
    last_scan_at: null,
    last_error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    kind,
    config: null,
    last_cursor: null,
  };
}

async function dueFirings(asOf = new Date()): Promise<TriggerFiring[]> {
  return Promise.resolve(documentFastSweepHandler.getDueFirings(asOf));
}

function expectScript(f: TriggerFiring): ScriptFiring {
  if (f.mode !== "script") throw new Error("expected script firing");
  return f;
}

beforeEach(() => {
  __resetFastSweepState();
  mocks.enabledSources = [];
  mocks.runRemote.mockReset();
  mocks.runRemote.mockResolvedValue({ scanned: 0, added: 0, updated: 0, unchanged: 0, errors: 0 });
  mocks.markScanned.mockReset();
});

describe("document-fast-sweep handler (ADR-0028)", () => {
  it("skips local_folder sources", async () => {
    mocks.enabledSources = [fakeSource("local-1", "local_folder")];
    expect(await dueFirings()).toHaveLength(0);
  });

  it("emits one ScriptFiring per remote source on the first tick", async () => {
    mocks.enabledSources = [
      fakeSource("conf-1", "confluence_space"),
      fakeSource("jira-1", "jira_project"),
      fakeSource("local-1", "local_folder"),
    ];
    const firings = await dueFirings();
    expect(firings).toHaveLength(2);
    for (const f of firings) {
      const s = expectScript(f);
      expect(s.kind).toBe(DOCUMENT_FAST_SWEEP_KIND);
      expect(s.script).toBe("documents.run_remote_source");
    }
  });

  it("throttles per-source: a second tick within the interval emits nothing for that source", async () => {
    mocks.enabledSources = [fakeSource("conf-1", "confluence_space")];
    const t0 = new Date(2026, 4, 26, 12, 0, 0);
    const firings1 = await dueFirings(t0);
    expect(firings1).toHaveLength(1);
    const f1 = expectScript(firings1[0]);

    documentFastSweepHandler.markFired(f1, { status: "done", preview: "", threadId: "" });

    const t1 = new Date(t0.getTime() + 30_000);
    expect(await dueFirings(t1)).toHaveLength(0);
  });

  it("re-emits after the throttle window elapses", async () => {
    mocks.enabledSources = [fakeSource("conf-1", "confluence_space")];
    const t0 = new Date();
    const firings1 = await dueFirings(t0);
    expect(firings1).toHaveLength(1);
    expectScript(firings1[0]);

    documentFastSweepHandler.markFired(firings1[0], {
      status: "done",
      preview: "",
      threadId: "",
    });

    const t1 = new Date(t0.getTime() + 70_000);
    __resetFastSweepState();
    expect(await dueFirings(t1)).toHaveLength(1);
  });

  it("markFired throttles even on error firings (Atlassian rate-limits)", async () => {
    mocks.enabledSources = [fakeSource("conf-1", "confluence_space")];
    const firings1 = await dueFirings();
    const f1 = expectScript(firings1[0]);

    documentFastSweepHandler.markFired(f1, {
      status: "error",
      preview: "",
      threadId: "",
      error: "rate limited",
    });

    expect(await dueFirings()).toHaveLength(0);
  });
});
