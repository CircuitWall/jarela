// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddSourceForm } from "./AddSourceForm";
import { SearchProbe } from "./SearchProbe";
import { RecallExclusions } from "./RecallExclusions";
import { defaultDocumentRecallPolicy } from "@/lib/documents/recall-policy";
import type { DocumentHit } from "@/api/types";

afterEach(cleanup);

describe("indexing consent", () => {
  it("requires source opt-in and warns for a nonlocal provider", async () => {
    const submit = vi.fn().mockResolvedValue(true);
    render(<AddSourceForm disabled={false} onSubmit={submit} configuredIntegrations={["gmail"]} localEmbeddings={false} />);
    fireEvent.change(screen.getByPlaceholderText("Pick or paste an absolute path"), { target: { value: "C:\\synthetic-documents" } });
    const add = screen.getByRole("button", { name: /add/i });
    expect(add.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("Content may leave this device");
    expect((screen.getByRole("option", { name: "Gmail mail" }) as HTMLOptionElement).disabled).toBe(false);
    expect((screen.getByRole("option", { name: /Outlook mail/ }) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(add);
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ path: "C:\\synthetic-documents", label: null }));
  });

  it("does not warn for local embeddings and preserves the form when consent is cancelled", async () => {
    const submit = vi.fn().mockResolvedValue(false);
    render(<AddSourceForm disabled={false} onSubmit={submit} configuredIntegrations={[]} localEmbeddings />);
    const path = screen.getByPlaceholderText("Pick or paste an absolute path") as HTMLInputElement;
    fireEvent.change(path, { target: { value: "C:\\synthetic-documents" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(path.value).toBe("C:\\synthetic-documents");
  });
});

describe("global exclusions", () => {
  it("saves normalized topics while retaining exact document exclusions", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const policy = {
      ...defaultDocumentRecallPolicy(),
      excluded_documents: [{ source_id: "s", path: "gmail://synthetic", label: "Private note" }],
    };
    render(<RecallExclusions policy={policy} onSave={save} />);
    fireEvent.change(screen.getByLabelText("Excluded topics"), { target: { value: " Project Atlas \n\nProject Atlas\nBank statements" } });
    fireEvent.click(screen.getByRole("button", { name: "Save topic exclusions" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ ...policy, topics: ["Project Atlas", "Bank statements"] }));
  });

  it("allows removing an exact exclusion without removing topic rules", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const policy = {
      ...defaultDocumentRecallPolicy(), topics: ["Project Atlas"],
      excluded_documents: [{ source_id: "s", path: "gmail://synthetic", label: "Private note" }],
    };
    render(<RecallExclusions policy={policy} onSave={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow again" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ ...policy, excluded_documents: [] }));
  });

  it("keeps preview overrides off by default and lets users select documents", async () => {
    const hit: DocumentHit = {
      document_id: "doc-1", source_id: "source-1", source_label: "Mail",
      rel_path: "Synthetic note", abs_path: "gmail://synthetic", chunk_index: 0,
      text: "Synthetic private text", score: 0.95, match: "semantic",
    };
    const search = vi.fn().mockResolvedValue([hit]);
    const exclude = vi.fn().mockResolvedValue(undefined);
    render(<SearchProbe onSearch={search} onExclude={exclude} />);
    fireEvent.change(screen.getByPlaceholderText(/Ask something/), { target: { value: "private topic" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(search).toHaveBeenCalledWith("private topic", false));
    fireEvent.click(await screen.findByRole("button", { name: "Exclude document" }));
    await waitFor(() => expect(exclude).toHaveBeenCalledWith(hit));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(search).toHaveBeenLastCalledWith("private topic", true));
  });
});
