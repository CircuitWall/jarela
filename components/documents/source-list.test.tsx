// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SourceList } from "./SourceList";
import type { DocumentSource } from "@/api/types";

afterEach(cleanup);

function source(overrides: Partial<DocumentSource> = {}): DocumentSource {
  return {
    id: "source-1",
    path: "C:\\synthetic-documents",
    label: "Synthetic",
    enabled: true,
    last_scan_at: null,
    last_error: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    kind: "local_folder",
    config: null,
    stats: { source_id: "source-1", document_count: 12, chunk_count: 34 },
    ...overrides,
  };
}

function renderList(sourceRow: DocumentSource, onClearIndex = vi.fn()) {
  render(
    <SourceList
      sources={[sourceRow]}
      loading={false}
      busy={{}}
      onReindex={vi.fn()}
      onRemove={vi.fn()}
      onToggle={vi.fn()}
      onClearIndex={onClearIndex}
    />,
  );
  return onClearIndex;
}

it("shows per-source document and chunk counts", () => {
  renderList(source());
  expect(screen.getByText("12 files")).toBeTruthy();
  expect(screen.getByText("34 chunks")).toBeTruthy();
});

it("offers clearing only for disabled sources that still hold chunks", () => {
  const first = renderList(source());
  expect(screen.queryByRole("button", { name: "Delete indexed chunks" })).toBeNull();
  cleanup();

  const second = renderList(source({ enabled: false }));
  fireEvent.click(screen.getByRole("button", { name: "Delete indexed chunks" }));
  expect(second).toHaveBeenCalledWith("source-1");
  cleanup();

  renderList(source({ enabled: false, stats: { source_id: "source-1", document_count: 0, chunk_count: 0 } }));
  expect(screen.queryByRole("button", { name: "Delete indexed chunks" })).toBeNull();
  expect(first).not.toHaveBeenCalled();
});
