// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IndexMaintenance } from "./IndexMaintenance";
import type { DocumentIndexLifecycleResponse } from "@/api/types";

afterEach(cleanup);

function state(overrides: Partial<DocumentIndexLifecycleResponse["inventory"]> = {}): DocumentIndexLifecycleResponse {
  return {
    settings: { purge_disabled_after_days: 0 },
    inventory: {
      document_count: 53_995,
      chunk_count: 244_590,
      size_bytes: 3 * 1024 ** 3,
      free_bytes: 2 * 1024 ** 2,
      auto_vacuum: "incremental",
      ...overrides,
    },
    status: {
      running: false, action: null, started_at: null, finished_at: null, summary: null, error: null,
    },
  };
}

function renderPanel(lifecycle = state(), disabledChunks = 4_592) {
  const handlers = {
    onRefresh: vi.fn(),
    onSaveRetention: vi.fn().mockResolvedValue(undefined),
    onPurgeDisabled: vi.fn().mockResolvedValue(undefined),
    onReclaim: vi.fn().mockResolvedValue(undefined),
    onRewriteEmbeddings: vi.fn().mockResolvedValue(undefined),
    onVacuum: vi.fn().mockResolvedValue(undefined),
  };
  render(
    <IndexMaintenance
      lifecycle={lifecycle}
      busy={false}
      disabledChunks={disabledChunks}
      {...handlers}
    />,
  );
  return handlers;
}

function statValue(label: string): string {
  return screen.getByText(label).nextElementSibling?.textContent ?? "";
}

it("shows the index inventory and disabled-source retention", () => {
  renderPanel();
  expect(statValue("Documents").replace(/\D/g, "")).toBe("53995");
  expect(statValue("Chunks").replace(/\D/g, "")).toBe("244590");
  expect(statValue("Database")).toBe("3.0 GB");
  expect(statValue("Reclaimable")).toBe("2.0 MB");
  expect((screen.getByRole("spinbutton", { name: /Purge disabled sources after/ }) as HTMLInputElement).value)
    .toBe("0");
});

it("saves retention and runs the explicit maintenance actions", async () => {
  const handlers = renderPanel();
  fireEvent.change(screen.getByRole("spinbutton", { name: /Purge disabled sources after/ }), {
    target: { value: "30" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save retention" }));
  await waitFor(() => expect(handlers.onSaveRetention).toHaveBeenCalledWith(30));

  fireEvent.click(screen.getByRole("button", { name: "Purge disabled" }));
  expect(handlers.onPurgeDisabled).toHaveBeenCalledOnce();

  fireEvent.click(screen.getByRole("button", { name: "Reclaim space" }));
  expect(handlers.onReclaim).toHaveBeenCalledOnce();

  fireEvent.click(screen.getByRole("button", { name: "Rewrite embeddings" }));
  expect(handlers.onRewriteEmbeddings).toHaveBeenCalledOnce();

  fireEvent.click(screen.getByRole("button", { name: "Compact database" }));
  expect(handlers.onVacuum).toHaveBeenCalledOnce();
});

it("explains why live reclamation is unavailable and disables it", () => {
  renderPanel(state({ auto_vacuum: "none", free_bytes: 0 }));
  expect(screen.getByText(/Compact the database once/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reclaim space" }).hasAttribute("disabled")).toBe(true);
});

it("renders live status, outcomes, and errors", () => {
  const running = state();
  running.status = { ...running.status, running: true, action: "purge_source" };
  renderPanel(running);
  expect(screen.getByRole("status").textContent).toContain("Purging indexed chunks");
  cleanup();

  const failed = state();
  failed.status = { ...failed.status, error: "Synthetic maintenance failure" };
  renderPanel(failed);
  expect(screen.getByRole("alert").textContent).toContain("Synthetic maintenance failure");
});
