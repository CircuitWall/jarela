import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupIsolatedToolTest } from "./test-helpers";

const t = setupIsolatedToolTest("jarela-test-confluence-gaps-", {
  ATLASSIAN_URL: "https://test.atlassian.net",
  ATLASSIAN_EMAIL: "tester@example.com",
  ATLASSIAN_API_TOKEN: "test-token",
});

const {
  confluenceDeletePageTool,
  confluenceUpdateCommentTool,
  confluenceDeleteCommentTool,
  confluenceRemoveLabelTool,
  confluenceDeleteAttachmentTool,
} = await import("./atlassian");

beforeEach(() => { t.reset(); });
afterEach(() => { t.cleanup(); });

describe("confluence_delete_page", () => {
  it("soft-deletes (no purge) without requiring confirm", async () => {
    t.setResponses([{ status: 204, body: "" }]);
    const out = JSON.parse(await confluenceDeletePageTool.invoke({ page_id: "12345" }));
    expect(t.calls[0].init.method).toBe("DELETE");
    expect(t.calls[0].url).toMatch(/\/wiki\/api\/v2\/pages\/12345$/);
    expect(out).toEqual({ ok: true, deleted_page_id: "12345", purged: false });
  });

  it("refuses purge without matching confirm", async () => {
    const out = JSON.parse(await confluenceDeletePageTool.invoke({
      page_id: "12345", purge: true,
    }));
    expect(out.error).toMatch(/confirm to equal page_id/);
    expect(t.calls).toHaveLength(0);
  });

  it("permits purge with matching confirm and adds purge=true query param", async () => {
    t.setResponses([{ status: 204, body: "" }]);
    const out = JSON.parse(await confluenceDeletePageTool.invoke({
      page_id: "12345", purge: true, confirm: "12345",
    }));
    expect(t.calls[0].url).toMatch(/\?purge=true$/);
    expect(out).toMatchObject({ ok: true, purged: true });
  });
});

describe("confluence_update_comment", () => {
  it("auto-fetches version when not provided and PUTs to footer-comments", async () => {
    t.setResponses([
      { body: { id: "c1", version: { number: 3 } } },
      { body: { id: "c1", version: { number: 4 } } },
    ]);
    const out = JSON.parse(await confluenceUpdateCommentTool.invoke({
      comment_id: "c1", kind: "footer", body_text: "Updated comment",
    }));
    expect(t.calls[0].url).toMatch(/\/footer-comments\/c1$/);
    expect(t.calls[1].init.method).toBe("PUT");
    expect(t.calls[1].url).toMatch(/\/footer-comments\/c1$/);
    const body = JSON.parse(t.calls[1].init.body as string);
    expect(body.version.number).toBe(4);
    expect(body.body.representation).toBe("storage");
    expect(out).toEqual({ ok: true, comment_id: "c1", kind: "footer", version: 4 });
  });

  it("routes inline comments to /inline-comments", async () => {
    t.setResponses([{ body: { id: "c2", version: { number: 5 } } }]);
    await confluenceUpdateCommentTool.invoke({
      comment_id: "c2", kind: "inline", body_text: "x",
      version_number: 6, // skip the auto-fetch
    });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].url).toMatch(/\/inline-comments\/c2$/);
    const body = JSON.parse(t.calls[0].init.body as string);
    expect(body.version.number).toBe(6);
  });

  it("rejects when both body_text and body_storage are passed", async () => {
    const out = JSON.parse(await confluenceUpdateCommentTool.invoke({
      comment_id: "c1", kind: "footer", body_text: "hi", body_storage: "<p>hi</p>",
    }));
    expect(out.error).toMatch(/exactly one of body_text or body_storage/);
    expect(t.calls).toHaveLength(0);
  });
});

describe("confluence_delete_comment", () => {
  it("DELETEs footer comments", async () => {
    t.setResponses([{ status: 204, body: "" }]);
    const out = JSON.parse(await confluenceDeleteCommentTool.invoke({
      comment_id: "c1", kind: "footer",
    }));
    expect(t.calls[0].init.method).toBe("DELETE");
    expect(t.calls[0].url).toMatch(/\/footer-comments\/c1$/);
    expect(out).toEqual({ ok: true, deleted_comment_id: "c1", kind: "footer" });
  });

  it("DELETEs inline comments", async () => {
    t.setResponses([{ status: 204, body: "" }]);
    await confluenceDeleteCommentTool.invoke({ comment_id: "c2", kind: "inline" });
    expect(t.calls[0].url).toMatch(/\/inline-comments\/c2$/);
  });
});

describe("confluence_remove_label", () => {
  it("uses v1 endpoint with name query param", async () => {
    t.setResponses([{ status: 204, body: "" }]);
    const out = JSON.parse(await confluenceRemoveLabelTool.invoke({
      page_id: "12345", label: "runbook",
    }));
    expect(t.calls[0].init.method).toBe("DELETE");
    expect(t.calls[0].url).toMatch(/\/wiki\/rest\/api\/content\/12345\/label\?name=runbook$/);
    expect(out).toEqual({ ok: true, page_id: "12345", removed_label: "runbook" });
  });

  it("encodes label names with special chars", async () => {
    t.setResponses([{ status: 204, body: "" }]);
    await confluenceRemoveLabelTool.invoke({ page_id: "12345", label: "a/b c" });
    expect(t.calls[0].url).toMatch(/name=a%2Fb%20c$/);
  });
});

describe("confluence_delete_attachment", () => {
  it("soft-deletes without purge", async () => {
    t.setResponses([{ status: 204, body: "" }]);
    const out = JSON.parse(await confluenceDeleteAttachmentTool.invoke({ attachment_id: "att-1" }));
    expect(t.calls[0].url).toMatch(/\/wiki\/api\/v2\/attachments\/att-1$/);
    expect(out).toEqual({ ok: true, deleted_attachment_id: "att-1", purged: false });
  });

  it("refuses purge without matching confirm", async () => {
    const out = JSON.parse(await confluenceDeleteAttachmentTool.invoke({
      attachment_id: "att-1", purge: true,
    }));
    expect(out.error).toMatch(/confirm to equal attachment_id/);
    expect(t.calls).toHaveLength(0);
  });

  it("purges with matching confirm", async () => {
    t.setResponses([{ status: 204, body: "" }]);
    const out = JSON.parse(await confluenceDeleteAttachmentTool.invoke({
      attachment_id: "att-1", purge: true, confirm: "att-1",
    }));
    expect(t.calls[0].url).toMatch(/\?purge=true$/);
    expect(out).toMatchObject({ purged: true });
  });
});
