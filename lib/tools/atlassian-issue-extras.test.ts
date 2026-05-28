import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-issue-extras-"));
process.env.JARELA_DB_DIR = tmpRoot;
process.env.ATLASSIAN_URL = "https://test.atlassian.net";
process.env.ATLASSIAN_EMAIL = "tester@example.com";
process.env.ATLASSIAN_API_TOKEN = "test-token";
process.on("exit", () => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const {
  jiraGetCommentsTool,
  jiraUpdateCommentTool,
  jiraDeleteCommentTool,
  jiraGetAttachmentContentTool,
  jiraDeleteAttachmentTool,
  jiraAddWorklogTool,
  jiraListWorklogsTool,
  jiraGetChangelogTool,
} = await import("./atlassian");

type FetchCall = { url: string; init: RequestInit };
type QueuedResponse = { status?: number; body: unknown; headers?: Record<string, string> };

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
    const bodyText = noBody
      ? null
      : typeof next.body === "string" ? next.body
      : Buffer.isBuffer(next.body) ? next.body
      : JSON.stringify(next.body);
    return new Response(bodyText as BodyInit | null, {
      status,
      headers: next.headers ?? { "content-type": "application/json" },
    });
  };
  vi.stubGlobal("fetch", fake);
}

beforeEach(() => {
  calls = [];
  responses = [];
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("jira_get_comments", () => {
  it("paginates with startAt + maxResults and flattens ADF", async () => {
    responses = [{
      body: {
        startAt: 0, maxResults: 50, total: 75,
        comments: [{
          id: "10001",
          author: { displayName: "Alice" },
          created: "2026-05-01T10:00:00Z",
          updated: "2026-05-01T10:00:00Z",
          body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] },
        }],
      },
    }];
    const out = JSON.parse(await jiraGetCommentsTool.invoke({
      issue_key: "PROJ-1", start_at: 0, max_results: 50, order_by: "-created",
    }));
    expect(calls[0].url).toMatch(/\/issue\/PROJ-1\/comment\?/);
    expect(calls[0].url).toMatch(/startAt=0/);
    expect(calls[0].url).toMatch(/maxResults=50/);
    expect(calls[0].url).toMatch(/orderBy=-created/);
    expect(out.total).toBe(75);
    expect(out.comments[0]).toMatchObject({ id: "10001", author: "Alice", body: "Hello" });
  });
});

describe("jira_update_comment", () => {
  it("PUTs ADF body", async () => {
    responses = [{ body: { id: "10001" } }];
    const out = JSON.parse(await jiraUpdateCommentTool.invoke({
      issue_key: "PROJ-1", comment_id: "10001", body: "Updated text",
    }));
    expect(calls[0].init.method).toBe("PUT");
    expect(calls[0].url).toMatch(/\/issue\/PROJ-1\/comment\/10001$/);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.body.type).toBe("doc");
    expect(body.body.content[0].content[0].text).toBe("Updated text");
    expect(out).toEqual({ ok: true, comment_id: "10001" });
  });
});

describe("jira_delete_comment", () => {
  it("DELETEs and returns ok", async () => {
    responses = [{ status: 204, body: "" }];
    const out = JSON.parse(await jiraDeleteCommentTool.invoke({
      issue_key: "PROJ-1", comment_id: "10001",
    }));
    expect(calls[0].init.method).toBe("DELETE");
    expect(out).toEqual({ ok: true, deleted_comment_id: "10001", issue_key: "PROJ-1" });
  });
});

describe("jira_get_attachment_content", () => {
  it("returns text for text/* content types", async () => {
    responses = [{
      body: "log line 1\nlog line 2",
      headers: { "content-type": "text/plain" },
    }];
    const out = JSON.parse(await jiraGetAttachmentContentTool.invoke({
      content_url: "https://test.atlassian.net/secure/attachment/1/log.txt",
    }));
    expect(out.as).toBe("text");
    expect(out.content).toBe("log line 1\nlog line 2");
    expect(out.content_type).toBe("text/plain");
  });

  it("returns base64 for binary content types", async () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
    responses = [{ body: buf, headers: { "content-type": "image/png" } }];
    const out = JSON.parse(await jiraGetAttachmentContentTool.invoke({
      content_url: "/secure/attachment/2/img.png",
    }));
    expect(out.as).toBe("base64");
    expect(out.content).toBe(buf.toString("base64"));
  });

  it("forces text decode when as_text=true overrides binary content-type", async () => {
    responses = [{ body: "hi", headers: { "content-type": "application/octet-stream" } }];
    const out = JSON.parse(await jiraGetAttachmentContentTool.invoke({
      content_url: "/secure/attachment/3/x", as_text: true,
    }));
    expect(out.as).toBe("text");
    expect(out.content).toBe("hi");
  });

  it("surfaces non-ok responses as error", async () => {
    responses = [{ status: 404, body: "not found", headers: { "content-type": "text/plain" } }];
    const out = JSON.parse(await jiraGetAttachmentContentTool.invoke({
      content_url: "/secure/attachment/missing",
    }));
    expect(out.error).toMatch(/Atlassian 404/);
  });
});

describe("jira_delete_attachment", () => {
  it("DELETEs by id", async () => {
    responses = [{ status: 204, body: "" }];
    const out = JSON.parse(await jiraDeleteAttachmentTool.invoke({ attachment_id: "5001" }));
    expect(calls[0].init.method).toBe("DELETE");
    expect(calls[0].url).toMatch(/\/attachment\/5001$/);
    expect(out).toEqual({ ok: true, deleted_attachment_id: "5001" });
  });
});

describe("jira_add_worklog", () => {
  it("posts timeSpent + ADF comment", async () => {
    responses = [{ status: 201, body: { id: "9001" } }];
    const out = JSON.parse(await jiraAddWorklogTool.invoke({
      issue_key: "PROJ-1", time_spent: "1h 30m",
      started: "2026-05-28T09:00:00.000+0000",
      comment: "Investigated root cause",
    }));
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.timeSpent).toBe("1h 30m");
    expect(body.started).toBe("2026-05-28T09:00:00.000+0000");
    expect(body.comment.type).toBe("doc");
    expect(out).toEqual({ ok: true, worklog_id: "9001", issue_key: "PROJ-1" });
  });

  it("omits started/comment when not provided", async () => {
    responses = [{ status: 201, body: { id: "9002" } }];
    await jiraAddWorklogTool.invoke({ issue_key: "PROJ-1", time_spent: "30m" });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({ timeSpent: "30m" });
  });
});

describe("jira_list_worklogs", () => {
  it("paginates and shapes the response", async () => {
    responses = [{
      body: {
        startAt: 0, maxResults: 50, total: 2,
        worklogs: [{
          id: "9001",
          author: { displayName: "Alice" },
          timeSpent: "1h",
          timeSpentSeconds: 3600,
          started: "2026-05-28T09:00:00.000+0000",
          created: "2026-05-28T10:00:00.000+0000",
          updated: "2026-05-28T10:00:00.000+0000",
          comment: null,
        }],
      },
    }];
    const out = JSON.parse(await jiraListWorklogsTool.invoke({ issue_key: "PROJ-1" }));
    expect(out.total).toBe(2);
    expect(out.worklogs[0]).toMatchObject({
      id: "9001", author: "Alice", time_spent: "1h", time_spent_seconds: 3600,
    });
  });
});

describe("jira_get_changelog", () => {
  it("flattens entries to {field, from, to}", async () => {
    responses = [{
      body: {
        startAt: 0, maxResults: 50, total: 1,
        values: [{
          id: "11000",
          author: { displayName: "Alice" },
          created: "2026-05-28T11:00:00Z",
          items: [{
            field: "status",
            fieldtype: "jira",
            fromString: "To Do",
            toString: "In Progress",
          }, {
            field: "assignee",
            fieldtype: "jira",
            from: null,
            to: "alice@example.com",
          }],
        }],
      },
    }];
    const out = JSON.parse(await jiraGetChangelogTool.invoke({ issue_key: "PROJ-1" }));
    expect(out.changelog[0].items).toEqual([
      { field: "status", field_type: "jira", from: "To Do", to: "In Progress" },
      { field: "assignee", field_type: "jira", from: null, to: "alice@example.com" },
    ]);
  });
});
