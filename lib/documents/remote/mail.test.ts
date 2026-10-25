import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentSourceRow } from "@/lib/stores/document-sources";

const mocks = vi.hoisted(() => ({
  google: vi.fn(), graph: vi.fn(), scan: vi.fn(), credentials: vi.fn(),
  upsert: vi.fn(), evict: vi.fn(),
}));
vi.mock("@/lib/integrations/gmail-oauth", () => ({
  resolveGoogleAuth: () => ({}), googleFetch: mocks.google,
}));
vi.mock("@/lib/integrations/microsoft-oauth", () => ({
  resolveMicrosoftAuth: () => ({}), graphFetch: mocks.graph,
}));
vi.mock("@/lib/stores/integrations", () => ({ getIntegrationRaw: mocks.credentials }));
vi.mock("@/lib/tools/packages/optional-package", () => ({
  optionalFunction: () => mocks.scan,
}));
vi.mock("./upsert", () => ({ upsertRemoteDocument: mocks.upsert, evictMissing: mocks.evict }));
import { runMailIndexer } from "./mail";

function source(kind: DocumentSourceRow["kind"], config: Record<string, unknown>): DocumentSourceRow {
  return {
    id: "source", kind, config: JSON.stringify(config), path: "synthetic",
    label: "Synthetic mail", enabled: 1, last_cursor: null, last_error: null,
    last_scan_at: null, created_at: "", updated_at: "",
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.upsert.mockResolvedValue({ status: "added", chunks: 1, embedded: 1, embedError: null });
  mocks.evict.mockReturnValue(2);
  mocks.credentials.mockReturnValue({ apple_id: "synthetic@example.com", app_password: "synthetic" });
  mocks.google.mockImplementation(async (_auth, _name, _base, path: string) =>
    path.startsWith("/messages?") ? { messages: [] } : { id: "mail", payload: {} });
  mocks.graph.mockImplementation(async (_auth, path: string) =>
    path.includes("?") || path.startsWith("https:") ? { value: [] } : { id: "mail" });
  mocks.scan.mockResolvedValue(undefined);
});

describe("consistent mailbox scopes", () => {
  it.each(["gmail_mail", "outlook_mail", "icloud_mail"] as const)(
    "allows query-free Inbox archives for %s", async (kind) => {
      await runMailIndexer(source(kind, { scope: "inbox" }));
      expect(mocks.evict).not.toHaveBeenCalled();
      if (kind === "gmail_mail") {
        const qs = new URL(mocks.google.mock.calls[0][3], "https://example.com").searchParams;
        expect(qs.get("labelIds")).toBe("INBOX");
        expect(qs.has("q")).toBe(false);
      } else if (kind === "outlook_mail") {
        const [_, path, opts] = mocks.graph.mock.calls[0];
        expect(path).toContain("/me/mailFolders/inbox/messages?");
        expect(new URL(path, "https://example.com").searchParams.has("$search")).toBe(false);
        expect(opts.headers.Prefer).toBe('IdType="ImmutableId"');
      } else {
        expect(mocks.scan.mock.calls[0][1]).toMatchObject({ scope: "inbox", maxResults: undefined });
      }
    },
  );

  it("resolves an exact Gmail label and combines it with an optional query", async () => {
    mocks.google.mockResolvedValueOnce({ labels: [{ id: "Label_12", name: "Projects/Atlas" }] })
      .mockResolvedValueOnce({ messages: [] });
    await runMailIndexer(source("gmail_mail", { scope: "folder", folder: "Projects/Atlas", query: "newer_than:30d" }));
    const qs = new URL(mocks.google.mock.calls[1][3], "https://example.com").searchParams;
    expect(qs.get("labelIds")).toBe("Label_12");
    expect(qs.get("q")).toBe("newer_than:30d");
    expect(qs.get("includeSpamTrash")).toBe("true");
  });

  it("rejects nonexistent Gmail labels without touching the archive", async () => {
    mocks.google.mockResolvedValueOnce({ labels: [] });
    await expect(runMailIndexer(source("gmail_mail", { scope: "folder", folder: "missing" }))).rejects.toThrow("label not found");
    expect(mocks.evict).not.toHaveBeenCalled();
  });

  it("encodes Outlook folder IDs and follows short pages with next links", async () => {
    mocks.graph.mockResolvedValueOnce({ value: [{ id: "one" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next" })
      .mockResolvedValueOnce({ id: "one", subject: "First" })
      .mockResolvedValueOnce({ value: [{ id: "two" }] })
      .mockResolvedValueOnce({ id: "two", subject: "Second" });
    const stats = await runMailIndexer(source("outlook_mail", { scope: "folder", folder: "folder/id+" }));
    expect(mocks.graph.mock.calls[0][1]).toContain("/mailFolders/folder%2Fid%2B/messages?");
    expect(mocks.graph.mock.calls[2][1]).toBe("https://graph.microsoft.com/v1.0/next");
    expect(stats.added).toBe(2);
    expect(mocks.graph.mock.calls[1][2].headers.Prefer).toBe('IdType="ImmutableId"');
  });

  it.each(["gmail_mail", "outlook_mail"] as const)(
    "indexes more than 5,000 messages without an implicit cap for %s", async (kind) => {
      let offset = 0;
      const total = 5_001;
      const page = () => {
        const items = Array.from({ length: Math.min(100, total - offset) }, (_, i) => ({ id: String(offset + i) }));
        offset += items.length;
        return items;
      };
      if (kind === "gmail_mail") {
        mocks.google.mockImplementation(async (_auth, _name, _base, path: string) => {
          if (!path.startsWith("/messages?")) return { payload: {} };
          const messages = page();
          return { messages, nextPageToken: offset < total ? String(offset) : undefined };
        });
      } else {
        mocks.graph.mockImplementation(async (_auth, path: string) => {
          if (!path.includes("?")) return { id: path.split("/").pop() };
          const value = page();
          return { value, "@odata.nextLink": offset < total ? `/me/messages?offset=${offset}` : undefined };
        });
      }
      const stats = await runMailIndexer(source(kind, { scope: "all" }));
      expect(stats.scanned).toBe(total);
      expect(mocks.upsert).toHaveBeenCalledTimes(total);
      expect(mocks.evict).not.toHaveBeenCalled();
      if (kind === "gmail_mail") expect(mocks.google.mock.calls[0][3]).toContain("includeSpamTrash=true");
      else expect(mocks.graph.mock.calls[0][1]).toContain("/me/messages?");
    },
  );

  it.each(["gmail_mail", "outlook_mail"] as const)("honors an optional limit for %s", async (kind) => {
    const entries = [{ id: "one" }, { id: "two" }];
    if (kind === "gmail_mail") mocks.google.mockResolvedValueOnce({ messages: entries, nextPageToken: "next" });
    else mocks.graph.mockResolvedValueOnce({ value: entries, "@odata.nextLink": "/next" });
    const stats = await runMailIndexer(source(kind, { scope: "inbox", max_results: 1 }));
    expect(stats.scanned).toBe(1);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.evict).not.toHaveBeenCalled();
  });

  it("keeps Gmail messages when a later refresh no longer returns them", async () => {
    mocks.google.mockResolvedValueOnce({ messages: [{ id: "one" }] })
      .mockResolvedValueOnce({ payload: {} }).mockResolvedValueOnce({ messages: [] });
    const row = source("gmail_mail", { scope: "inbox" });
    await runMailIndexer(row);
    await runMailIndexer(row);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.evict).not.toHaveBeenCalled();
  });

  it("surfaces failed Gmail message reads without evicting existing documents", async () => {
    mocks.google.mockResolvedValueOnce({ messages: [{ id: "one" }] })
      .mockResolvedValueOnce({ error: "Message unavailable" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(runMailIndexer(source("gmail_mail", { scope: "inbox", retention: "mirror" }))).rejects.toThrow("1 Gmail messages could not be indexed");
      expect(mocks.evict).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not let embedding errors hide message failures or trigger mirror cleanup", async () => {
    mocks.google.mockResolvedValueOnce({ messages: [{ id: "one" }, { id: "two" }] })
      .mockResolvedValueOnce({ error: "Message unavailable" })
      .mockResolvedValueOnce({ payload: {} });
    mocks.upsert.mockResolvedValueOnce({
      status: "added", chunks: 1, embedded: 0, embedError: "Embedding provider unavailable",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(runMailIndexer(source("gmail_mail", { scope: "inbox", retention: "mirror" })))
        .rejects.toThrow("1 Gmail messages could not be indexed");
      expect(mocks.evict).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each(["gmail_mail", "outlook_mail"] as const)("preserves query-only mirror defaults for %s", async (kind) => {
    const count = 250;
    let listed = 0;
    const entries = () => Array.from({ length: Math.min(100, count - listed) }, (_, i) => ({ id: String(listed + i) }));
    if (kind === "gmail_mail") {
      mocks.google.mockImplementation(async (_auth, _name, _base, path: string) => {
        if (!path.startsWith("/messages?")) return { payload: {} };
        const messages = entries(); listed += messages.length;
        return { messages, nextPageToken: "next" };
      });
    } else {
      mocks.graph.mockImplementation(async (_auth, path: string) => {
        if (!path.includes("?")) return { id: path.split("/").pop() };
        const value = entries(); listed += value.length;
        return { value, "@odata.nextLink": "/me/messages?next=1" };
      });
    }
    const stats = await runMailIndexer(source(kind, { query: "budget" }));
    expect(stats.scanned).toBe(count);
    expect(stats.removed).toBe(2);
    expect(mocks.evict).toHaveBeenCalledOnce();
  });

  it("does not evict after a provider pagination failure", async () => {
    mocks.graph.mockResolvedValueOnce({ value: [{ id: "one" }], "@odata.nextLink": "/next" })
      .mockResolvedValueOnce({ id: "one" }).mockResolvedValueOnce({ error: "Permission denied" });
    await expect(runMailIndexer(source("outlook_mail", { scope: "all", retention: "mirror" }))).rejects.toThrow("Permission denied");
    expect(mocks.evict).not.toHaveBeenCalled();
  });

  it("reports the Outlook search ceiling rather than silently claiming full coverage", async () => {
    let offset = 0;
    mocks.graph.mockImplementation(async (_auth, path: string) => {
      if (!path.includes("?")) return { id: path.split("/").pop() };
      const value = Array.from({ length: 100 }, (_, i) => ({ id: String(offset + i) }));
      offset += 100;
      return { value, "@odata.nextLink": offset < 1_000 ? "/me/messages?next=1" : undefined };
    });
    await expect(runMailIndexer(source("outlook_mail", { scope: "all", query: "budget" }))).rejects.toThrow("1,000-result ceiling");
    expect(mocks.evict).not.toHaveBeenCalled();
  });

  it("wires iCloud credentials, body conversion, and archive retention", async () => {
    mocks.scan.mockImplementation(async (_auth, _options, onMessage) => {
      await onMessage({ id: "message-id:synthetic", subject: "Synthetic", from: "", to: "", date: null, text: "<p>Hello</p>", html: true });
    });
    const stats = await runMailIndexer(source("icloud_mail", { scope: "folder", folder: "Archive", max_results: 10 }));
    expect(mocks.credentials).toHaveBeenCalledWith("icloud");
    expect(mocks.scan.mock.calls[0][1]).toMatchObject({ scope: "folder", folder: "Archive", maxResults: 10 });
    expect(stats.added).toBe(1);
    expect(mocks.upsert.mock.calls[0][1].text).toContain("Hello");
    expect(mocks.upsert.mock.calls[0][1].text).not.toContain("<p>");
    expect(mocks.upsert.mock.calls[0][1].path).toMatch(/^icloud:\/\/[a-f0-9]{64}$/);
    expect(mocks.evict).not.toHaveBeenCalled();
  });

  it("surfaces missing iCloud credentials and scan errors", async () => {
    mocks.credentials.mockReturnValueOnce(null);
    await expect(runMailIndexer(source("icloud_mail", { scope: "inbox" }))).rejects.toThrow("iCloud not configured");
    mocks.scan.mockRejectedValueOnce(new Error("IMAP authentication failed"));
    await expect(runMailIndexer(source("icloud_mail", { scope: "all" }))).rejects.toThrow("IMAP authentication failed");
    expect(mocks.evict).not.toHaveBeenCalled();
  });
});
