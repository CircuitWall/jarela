import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  setAuthResolver,
  resolveCustomFieldNames,
  extractFieldValue,
  confluenceTextToStorage,
  parseV2NextCursor,
  confluenceCreatePageTool,
  confluenceUpdatePageTool,
  confluenceGetPageTool,
  confluenceGetCommentsTool,
  confluenceUploadAttachmentTool,
  confluenceMovePageTool,
  confluenceGetAttachmentContentTool,
  type JiraFieldDef,
} from "../src/index";

setAuthResolver(() => ({
  url: "https://test.atlassian.net",
  email: "tester@example.com",
  apiToken: "test-token",
}));

const fields: JiraFieldDef[] = [
  { id: "summary", name: "Summary", custom: false },
  { id: "customfield_10473", name: "Vulnerability Description", custom: true },
  { id: "customfield_10500", name: "Affected Component", custom: true },
  { id: "customfield_10600", name: "Story Points", custom: true },
];

type FetchCall = { url: string; init: RequestInit };
type QueuedResponse = {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
};

let calls: FetchCall[] = [];
let responses: QueuedResponse[] = [];

function installFetch() {
  const fake: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    calls.push({ url, init: init ?? {} });
    const next = responses.shift();
    if (!next) {
      // Surface unexpected fetches loudly rather than returning a default 200.
      throw new Error(`unexpected fetch: ${url}`);
    }
    const bodyText =
      typeof next.body === "string" ? next.body
      : Buffer.isBuffer(next.body) ? next.body
      : JSON.stringify(next.body);
    return new Response(bodyText as BodyInit, {
      status: next.status ?? 200,
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

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("resolveCustomFieldNames", () => {
  it("matches by exact customfield id", () => {
    const r = resolveCustomFieldNames(["customfield_10473"], fields);
    expect(r.resolved).toEqual([
      { input: "customfield_10473", id: "customfield_10473", name: "Vulnerability Description" },
    ]);
    expect(r.unresolved).toEqual([]);
  });

  it("matches display names case-insensitively with surrounding whitespace", () => {
    const r = resolveCustomFieldNames(["  vulnerability description  "], fields);
    expect(r.resolved).toEqual([
      { input: "  vulnerability description  ", id: "customfield_10473", name: "Vulnerability Description" },
    ]);
  });

  it("partitions resolved and unresolved inputs", () => {
    const r = resolveCustomFieldNames(
      ["Story Points", "Bogus Field", "customfield_10500"],
      fields,
    );
    expect(r.resolved.map((x) => x.id)).toEqual(["customfield_10600", "customfield_10500"]);
    expect(r.unresolved).toEqual(["Bogus Field"]);
  });

  it("returns empty results for empty input", () => {
    expect(resolveCustomFieldNames([], fields)).toEqual({ resolved: [], unresolved: [] });
  });
});

describe("extractFieldValue", () => {
  it("prefers rendered HTML, stripped to plain text", () => {
    const adf = { type: "doc", version: 1, content: [] };
    const html = "<p>SQL injection in <strong>/api/login</strong></p><p>CVE-2024-9999</p>";
    expect(extractFieldValue(adf, html)).toBe("SQL injection in /api/login\n\nCVE-2024-9999");
  });

  it("falls back to simplifyADF when no rendered HTML", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello world" }] }],
    };
    expect(extractFieldValue(adf, undefined)).toBe("hello world");
  });

  it("passes through scalar values", () => {
    expect(extractFieldValue("plain text", undefined)).toBe("plain text");
    expect(extractFieldValue(8, undefined)).toBe(8);
    expect(extractFieldValue(true, undefined)).toBe(true);
    expect(extractFieldValue(null, undefined)).toBe(null);
  });

  it("flattens single-select option { value }", () => {
    expect(extractFieldValue({ value: "High", id: "10001" }, undefined)).toBe("High");
  });

  it("flattens user picker { displayName }", () => {
    expect(extractFieldValue({ accountId: "abc", displayName: "Andrew Wu" }, undefined)).toBe("Andrew Wu");
  });

  it("flattens status/priority { name }", () => {
    expect(extractFieldValue({ name: "In Progress" }, undefined)).toBe("In Progress");
  });

  it("flattens arrays of options to their string values", () => {
    expect(
      extractFieldValue(
        [{ value: "alpha" }, { value: "beta" }, { name: "gamma" }],
        undefined,
      ),
    ).toEqual(["alpha", "beta", "gamma"]);
  });

  it("converts <li> to bullets and <br> to newlines", () => {
    const html = "<ul><li>one</li><li>two</li></ul>";
    expect(extractFieldValue(null, html)).toBe("• one\n• two");
  });

  it("decodes common HTML entities", () => {
    expect(extractFieldValue(null, "&lt;script&gt; &amp; more")).toBe("<script> & more");
  });
});

describe("confluenceTextToStorage", () => {
  it("returns an empty paragraph for empty input", () => {
    expect(confluenceTextToStorage("")).toBe("<p></p>");
  });

  it("escapes &, <, > so Confluence storage doesn't reject the body", () => {
    expect(confluenceTextToStorage("AT&T <foo> & </bar>")).toBe(
      "<p>AT&amp;T &lt;foo&gt; &amp; &lt;/bar&gt;</p>",
    );
  });

  it("splits on blank lines into <p> blocks", () => {
    expect(confluenceTextToStorage("one\n\ntwo\n\nthree")).toBe(
      "<p>one</p><p>two</p><p>three</p>",
    );
  });

  it("converts a single newline inside a paragraph to <br/>", () => {
    expect(confluenceTextToStorage("line a\nline b")).toBe("<p>line a<br/>line b</p>");
  });

  it("collapses 3+ blank lines into a single paragraph break", () => {
    expect(confluenceTextToStorage("a\n\n\n\nb")).toBe("<p>a</p><p>b</p>");
  });
});

describe("parseV2NextCursor", () => {
  it("returns null for undefined input", () => {
    expect(parseV2NextCursor(undefined)).toBe(null);
  });

  it("returns null when cursor is absent", () => {
    expect(parseV2NextCursor("/wiki/api/v2/pages?limit=25")).toBe(null);
  });

  it("extracts cursor from a query string", () => {
    expect(parseV2NextCursor("/wiki/api/v2/pages?limit=25&cursor=abc123")).toBe("abc123");
  });

  it("decodes percent-encoded cursors", () => {
    expect(parseV2NextCursor("/x?cursor=foo%2Bbar%3D")).toBe("foo+bar=");
  });

  it("works when cursor is the first param", () => {
    expect(parseV2NextCursor("/x?cursor=xyz&limit=25")).toBe("xyz");
  });
});

// ── Tool handlers (mocked fetch) ────────────────────────────────────────────
//
// Note: resolveSpaceId caches `${auth.url}|${spaceKey}` for 1h. Tests that
// exercise space-key resolution use a unique space_key each time so the
// cache never short-circuits the GET we want to assert on.

describe("confluence_create_page", () => {
  it("resolves space_key, then POSTs to /pages with the storage-format body", async () => {
    responses.push(
      { status: 200, body: { results: [{ id: "9001", key: "ENGCREATE" }] } },
      { status: 200, body: { id: "p1", title: "T", spaceId: "9001", parentId: null, version: { number: 1 }, _links: { webui: "/spaces/ENGCREATE/pages/p1" } } },
    );
    const out = await confluenceCreatePageTool.invoke({
      space_key: "ENGCREATE",
      title: "T",
      body_text: "hello\n\nworld",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://test.atlassian.net/wiki/api/v2/spaces?keys=ENGCREATE&limit=1");
    expect(calls[1].url).toBe("https://test.atlassian.net/wiki/api/v2/pages");
    expect(calls[1].init.method).toBe("POST");
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      spaceId: "9001",
      status: "current",
      title: "T",
      body: { representation: "storage", value: "<p>hello</p><p>world</p>" },
    });
    expect(JSON.parse(out)).toMatchObject({
      ok: true, id: "p1", title: "T", space_id: "9001", version: 1,
      url: "https://test.atlassian.net/wiki/spaces/ENGCREATE/pages/p1",
    });
  });

  it("rejects body_storage containing <script> before any write fetch", async () => {
    responses.push({ status: 200, body: { results: [{ id: "9002", key: "ENGSCRIPT" }] } });
    const out = await confluenceCreatePageTool.invoke({
      space_key: "ENGSCRIPT",
      title: "T",
      body_storage: "<p>ok</p><script>alert(1)</script>",
    });
    // Only the space-resolution fetch should have fired.
    expect(calls).toHaveLength(1);
    expect(JSON.parse(out).error).toMatch(/<script>\/<style>/);
  });

  it("rejects when both body_text and body_storage are supplied", async () => {
    responses.push({ status: 200, body: { results: [{ id: "9003", key: "ENGBOTH" }] } });
    const out = await confluenceCreatePageTool.invoke({
      space_key: "ENGBOTH",
      title: "T",
      body_text: "x",
      body_storage: "<p>x</p>",
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(out).error).toMatch(/exactly one of body_text or body_storage, not both/);
  });
});

describe("confluence_update_page", () => {
  it("auto-fetches current version+title, then PUTs with version+1 and original title", async () => {
    responses.push(
      { status: 200, body: { id: "p7", title: "Existing Title", version: { number: 7 } } },
      { status: 200, body: { id: "p7", title: "Existing Title", version: { number: 8 }, _links: { webui: "/spaces/E/pages/p7" } } },
    );
    const out = await confluenceUpdatePageTool.invoke({
      page_id: "p7",
      body_text: "new body",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://test.atlassian.net/wiki/api/v2/pages/p7");
    // First call is the GET for current version+title (no method = GET).
    expect(calls[0].init.method).toBeUndefined();
    expect(calls[1].url).toBe("https://test.atlassian.net/wiki/api/v2/pages/p7");
    expect(calls[1].init.method).toBe("PUT");
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      id: "p7",
      status: "current",
      title: "Existing Title",
      body: { representation: "storage", value: "<p>new body</p>" },
      version: { number: 8 },
    });
    expect(JSON.parse(out)).toMatchObject({ ok: true, id: "p7", version: 8 });
  });

  it("skips the GET when caller supplies version_number and title", async () => {
    responses.push(
      { status: 200, body: { id: "p8", title: "Forced", version: { number: 5 } } },
    );
    await confluenceUpdatePageTool.invoke({
      page_id: "p8",
      title: "Forced",
      body_text: "x",
      version_number: 5,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("PUT");
  });
});

describe("confluence_get_page", () => {
  it("requests both storage and view bodies and returns version + url", async () => {
    responses.push({
      status: 200,
      body: {
        id: "p1",
        title: "Page",
        spaceId: "9000",
        parentId: null,
        status: "current",
        version: { number: 3 },
        body: {
          storage: { value: "<p>storage body</p>" },
          view: { value: "<p>view body</p>" },
        },
        _links: { webui: "/spaces/E/pages/p1" },
      },
    }, {
      status: 200,
      body: {
        id: "p1",
        title: "Page",
        body: {
          view: { value: "<p>view body</p>" },
        },
      },
    });
    const out = await confluenceGetPageTool.invoke({ page_id: "p1" });

    expect(calls[0].url).toBe(
      "https://test.atlassian.net/wiki/api/v2/pages/p1?body-format=storage&include-version=true",
    );
    expect(calls[1].url).toBe(
      "https://test.atlassian.net/wiki/api/v2/pages/p1?body-format=view&include-version=true",
    );
    expect(JSON.parse(out)).toEqual({
      id: "p1",
      title: "Page",
      url: "https://test.atlassian.net/wiki/spaces/E/pages/p1",
      space_id: "9000",
      parent_id: null,
      status: "current",
      version: 3,
      body_storage: "<p>storage body</p>",
      body_storage_truncated: false,
      body_view: "<p>view body</p>",
      body_view_truncated: false,
    });
  });
});

describe("confluence_get_comments", () => {
  it("returns footer comments and surfaces inline-comments 404 as inline_warning", async () => {
    responses.push(
      // Footer comments — happy path.
      {
        status: 200,
        body: {
          results: [
            {
              id: "c1",
              version: { number: 1, createdAt: "2026-05-01T00:00:00Z", authorId: "u1" },
              body: { storage: { value: "<p>ok</p>" } },
              parentCommentId: null,
            },
          ],
        },
      },
      // Inline comments — known v2 bug, 404 with error envelope.
      { status: 404, body: { errors: [{ status: 404, title: "Not Found" }] } },
    );
    const out = await confluenceGetCommentsTool.invoke({ page_id: "p1" });
    const parsed = JSON.parse(out);
    expect(parsed.footer_comments).toHaveLength(1);
    expect(parsed.footer_comments[0]).toMatchObject({ id: "c1", version: 1, body_storage: "<p>ok</p>" });
    expect(parsed.inline_comments).toEqual([]);
    expect(parsed.inline_warning).toMatch(/404/);
  });
});

describe("confluence_upload_attachment", () => {
  it("POSTs multipart with X-Atlassian-Token: no-check to the v1 endpoint", async () => {
    responses.push({
      status: 200,
      body: {
        results: [
          { id: "att1", title: "data.csv", metadata: { mediaType: "text/csv" }, extensions: { fileSize: 7 } },
        ],
      },
    });
    const out = await confluenceUploadAttachmentTool.invoke({
      page_id: "p9",
      filename: "data.csv",
      content_text: "a,b\n1,2",
    });

    expect(calls[0].url).toBe(
      "https://test.atlassian.net/wiki/rest/api/content/p9/child/attachment",
    );
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-Atlassian-Token"]).toBe("no-check");
    // Don't set Content-Type explicitly — fetch fills in the multipart boundary.
    expect(headers["Content-Type"]).toBeUndefined();
    expect(calls[0].init.body).toBeInstanceOf(FormData);
    expect((calls[0].init.body as FormData).has("file")).toBe(true);
    expect(JSON.parse(out)).toMatchObject({
      ok: true,
      page_id: "p9",
      attachments: [{ id: "att1", title: "data.csv", media_type: "text/csv", file_size: 7 }],
    });
  });

  it("rejects empty payloads before any network call", async () => {
    const out = await confluenceUploadAttachmentTool.invoke({
      page_id: "p9",
      filename: "x.txt",
    });
    expect(calls).toHaveLength(0);
    expect(JSON.parse(out).error).toMatch(/content_base64.*content_text/);
  });
});

describe("confluence_move_page", () => {
  it("PUTs the parameterized move endpoint and echoes the request shape on success", async () => {
    responses.push({ status: 200, body: {} });
    const out = await confluenceMovePageTool.invoke({
      page_id: "p1",
      position: "append",
      target_id: "p99",
    });
    expect(calls[0].url).toBe(
      "https://test.atlassian.net/wiki/api/v2/pages/p1/move/append/p99",
    );
    expect(calls[0].init.method).toBe("PUT");
    expect(JSON.parse(out)).toEqual({ ok: true, page_id: "p1", position: "append", target_id: "p99" });
  });
});

describe("confluence_get_attachment_content", () => {
  it("prefixes /wiki onto a relative download_link and returns base64 for binary", async () => {
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]); // PNG magic-ish
    responses.push({
      status: 200,
      body: bin,
      headers: { "content-type": "image/png" },
    });
    const out = await confluenceGetAttachmentContentTool.invoke({
      download_link: "/download/attachments/p1/icon.png",
    });
    expect(calls[0].url).toBe(
      "https://test.atlassian.net/wiki/download/attachments/p1/icon.png",
    );
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ content_type: "image/png", as: "base64", size: 5 });
    expect(parsed.content).toBe(bin.toString("base64"));
  });

  it("returns plain text (capped) for text-like content types", async () => {
    responses.push({
      status: 200,
      body: "hello, world",
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
    const out = await confluenceGetAttachmentContentTool.invoke({
      download_link: "https://test.atlassian.net/wiki/download/attachments/p1/notes.txt",
    });
    expect(calls[0].url).toBe(
      "https://test.atlassian.net/wiki/download/attachments/p1/notes.txt",
    );
    expect(JSON.parse(out)).toMatchObject({
      as: "text",
      size: 12,
      content: "hello, world",
      truncated: false,
    });
  });
});
