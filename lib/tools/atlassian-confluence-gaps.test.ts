import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-confluence-gaps-"));
process.env.JARELA_DB_DIR = tmpRoot;
process.env.ATLASSIAN_URL = "https://test.atlassian.net";
process.env.ATLASSIAN_EMAIL = "tester@example.com";
process.env.ATLASSIAN_API_TOKEN = "test-token";
process.on("exit", () => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const {
  confluenceDeletePageTool,
  confluenceUpdateCommentTool,
  confluenceDeleteCommentTool,
  confluenceRemoveLabelTool,
  confluenceDeleteAttachmentTool,
} = await import("./atlassian");

type FetchCall = { url: string; init: RequestInit };
type QueuedResponse = { status?: number; body: unknown };

let calls: FetchCall[] = [];
let responses: QueuedResponse[] = [];

function installFetch() {
  const fake: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    calls.push({ url, init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    const status = next.status ?? 200;
    const noBody = status === 204 || status === 205 || status === 304;
    const bodyText = noBody ? null : typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(bodyText, { status, headers: { "content-type": "application/json" } });
  };
  vi.stubGlobal("fetch", fake);
}

beforeEach(() => { calls = []; responses = []; installFetch(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("confluence_delete_page", () => {
  it("soft-deletes (no purge) without requiring confirm", async () => {
    responses = [{ status: 204, body: "" }];
    const out = JSON.parse(await confluenceDeletePageTool.invoke({ page_id: "12345" }));
    expect(calls[0].init.method).toBe("DELETE");
    expect(calls[0].url).toMatch(/\/wiki\/api\/v2\/pages\/12345$/);
    expect(out).toEqual({ ok: true, deleted_page_id: "12345", purged: false });
  });

  it("refuses purge without matching confirm", async () => {
    const out = JSON.parse(await confluenceDeletePageTool.invoke({
      page_id: "12345", purge: true,
    }));
    expect(out.error).toMatch(/confirm to equal page_id/);
    expect(calls).toHaveLength(0);
  });

  it("permits purge with matching confirm and adds purge=true query param", async () => {
    responses = [{ status: 204, body: "" }];
    const out = JSON.parse(await confluenceDeletePageTool.invoke({
      page_id: "12345", purge: true, confirm: "12345",
    }));
    expect(calls[0].url).toMatch(/\?purge=true$/);
    expect(out).toMatchObject({ ok: true, purged: true });
  });
});

describe("confluence_update_comment", () => {
  it("auto-fetches version when not provided and PUTs to footer-comments", async () => {
    responses = [
      { body: { id: "c1", version: { number: 3 } } },
      { body: { id: "c1", version: { number: 4 } } },
    ];
    const out = JSON.parse(await confluenceUpdateCommentTool.invoke({
      comment_id: "c1", kind: "footer", body_text: "Updated comment",
    }));
    expect(calls[0].url).toMatch(/\/footer-comments\/c1$/);
    expect(calls[1].init.method).toBe("PUT");
    expect(calls[1].url).toMatch(/\/footer-comments\/c1$/);
    const body = JSON.parse(calls[1].init.body as string);
    expect(body.version.number).toBe(4);
    expect(body.body.representation).toBe("storage");
    expect(out).toEqual({ ok: true, comment_id: "c1", kind: "footer", version: 4 });
  });

  it("routes inline comments to /inline-comments", async () => {
    responses = [{ body: { id: "c2", version: { number: 5 } } }];
    await confluenceUpdateCommentTool.invoke({
      comment_id: "c2", kind: "inline", body_text: "x",
      version_number: 6, // skip the auto-fetch
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/inline-comments\/c2$/);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.version.number).toBe(6);
  });

  it("rejects when both body_text and body_storage are passed", async () => {
    const out = JSON.parse(await confluenceUpdateCommentTool.invoke({
      comment_id: "c1", kind: "footer", body_text: "hi", body_storage: "<p>hi</p>",
    }));
    expect(out.error).toMatch(/exactly one of body_text or body_storage/);
    expect(calls).toHaveLength(0);
  });
});

describe("confluence_delete_comment", () => {
  it("DELETEs footer comments", async () => {
    responses = [{ status: 204, body: "" }];
    const out = JSON.parse(await confluenceDeleteCommentTool.invoke({
      comment_id: "c1", kind: "footer",
    }));
    expect(calls[0].init.method).toBe("DELETE");
    expect(calls[0].url).toMatch(/\/footer-comments\/c1$/);
    expect(out).toEqual({ ok: true, deleted_comment_id: "c1", kind: "footer" });
  });

  it("DELETEs inline comments", async () => {
    responses = [{ status: 204, body: "" }];
    await confluenceDeleteCommentTool.invoke({ comment_id: "c2", kind: "inline" });
    expect(calls[0].url).toMatch(/\/inline-comments\/c2$/);
  });
});

describe("confluence_remove_label", () => {
  it("uses v1 endpoint with name query param", async () => {
    responses = [{ status: 204, body: "" }];
    const out = JSON.parse(await confluenceRemoveLabelTool.invoke({
      page_id: "12345", label: "runbook",
    }));
    expect(calls[0].init.method).toBe("DELETE");
    expect(calls[0].url).toMatch(/\/wiki\/rest\/api\/content\/12345\/label\?name=runbook$/);
    expect(out).toEqual({ ok: true, page_id: "12345", removed_label: "runbook" });
  });

  it("encodes label names with special chars", async () => {
    responses = [{ status: 204, body: "" }];
    await confluenceRemoveLabelTool.invoke({ page_id: "12345", label: "a/b c" });
    expect(calls[0].url).toMatch(/name=a%2Fb%20c$/);
  });
});

describe("confluence_delete_attachment", () => {
  it("soft-deletes without purge", async () => {
    responses = [{ status: 204, body: "" }];
    const out = JSON.parse(await confluenceDeleteAttachmentTool.invoke({ attachment_id: "att-1" }));
    expect(calls[0].url).toMatch(/\/wiki\/api\/v2\/attachments\/att-1$/);
    expect(out).toEqual({ ok: true, deleted_attachment_id: "att-1", purged: false });
  });

  it("refuses purge without matching confirm", async () => {
    const out = JSON.parse(await confluenceDeleteAttachmentTool.invoke({
      attachment_id: "att-1", purge: true,
    }));
    expect(out.error).toMatch(/confirm to equal attachment_id/);
    expect(calls).toHaveLength(0);
  });

  it("purges with matching confirm", async () => {
    responses = [{ status: 204, body: "" }];
    const out = JSON.parse(await confluenceDeleteAttachmentTool.invoke({
      attachment_id: "att-1", purge: true, confirm: "att-1",
    }));
    expect(calls[0].url).toMatch(/\?purge=true$/);
    expect(out).toMatchObject({ purged: true });
  });
});
