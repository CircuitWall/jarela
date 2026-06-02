// Confluence tools — search, get/list pages + spaces, comments, labels,
// attachments, plus v2 gap-fillers (page/comment delete, label remove).
// Split out of the monolithic lib/tools/atlassian.ts in the bloat-audit
// refactor.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { parseJsonSafe } from "@/lib/utils/json";
import { resolveAuth, atlassianFetch, authHeader } from "./_auth";
import {
  resolveBody,
  resolveSpaceId,
  parseV2NextCursor,
  confluenceTextToStorage,
} from "./_helpers";

// Most tools below use the Confluence v2 REST API (/wiki/api/v2/...). Three
// gaps still require v1 paths as of 2026 and are flagged inline:
//   - confluence_search: v2 has no CQL endpoint.
//   - confluence_upload_attachment: v2 Attachment group is read-only (CONFCLOUD-77196).
//   - confluence_add_label: v2 Label group is read-only (CONFCLOUD-76866).
// The remote document-RAG indexer in lib/documents/remote/confluence.ts (ADR-0026)
// stays on v1 — it has its own concerns and is intentionally untouched here.

export const confluenceSearchTool = tool(
  async ({ cql, max_results }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const limit = Math.min(max_results ?? 15, 50);
    // v1: CQL search has no v2 equivalent.
    const data = await atlassianFetch(
      auth,
      `/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}`,
    ) as { results?: Array<Record<string, unknown>>; size?: number; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      total: data.size,
      results: (data.results ?? []).map((r: Record<string, unknown>) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        url: `${auth.url}/wiki${((r._links as Record<string, unknown>)?.webui) ?? ""}`,
      })),
    });
  },
  {
    name: "confluence_search",
    description:
      "Search Confluence pages with CQL (Confluence Query Language). " +
      "Examples: 'type=page AND title~\"runbook\"', 'space=ENG AND lastmodified > now(\"-7d\")'.",
    schema: z.object({
      cql: z.string().describe("CQL query string"),
      max_results: z.number().optional().describe("Max results (default 15, max 50)"),
    }),
  },
);

export const confluenceGetPageTool = tool(
  async ({ page_id }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/pages/${encodeURIComponent(page_id)}?body-format=storage,view&include-version=true`,
    ) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    const body = data.body as Record<string, Record<string, unknown> | undefined> | undefined;
    const storageVal = body?.storage?.value as string | undefined;
    const viewVal = body?.view?.value as string | undefined;
    const links = data._links as Record<string, unknown> | undefined;
    const webui = links?.webui as string | undefined;
    return JSON.stringify({
      id: data.id,
      title: data.title,
      url: webui ? `${auth.url}/wiki${webui}` : null,
      space_id: data.spaceId ?? null,
      parent_id: data.parentId ?? null,
      status: data.status,
      version: (data.version as Record<string, unknown> | undefined)?.number ?? null,
      // body_storage round-trips into confluence_update_page; body_view is rendered HTML
      // for summarization. Each capped to 20KB to keep context lean.
      body_storage: storageVal ? storageVal.slice(0, 20_000) : null,
      body_storage_truncated: storageVal ? storageVal.length > 20_000 : false,
      body_view: viewVal ? viewVal.slice(0, 20_000) : null,
      body_view_truncated: viewVal ? viewVal.length > 20_000 : false,
    });
  },
  {
    name: "confluence_get_page",
    description:
      "Fetch a Confluence page by id (v2). Returns title, space_id, parent_id, version, and BOTH " +
      "body_storage (round-trippable into confluence_update_page) and body_view (rendered HTML, " +
      "easier to summarize). Each body capped at 20KB.",
    schema: z.object({
      page_id: z.string(),
    }),
  },
);

export const confluenceGetPageByTitleTool = tool(
  async ({ space_key, title, include_body }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const sid = await resolveSpaceId(auth, space_key);
    if (typeof sid !== "string") return JSON.stringify(sid);
    const params = new URLSearchParams({ title, "space-id": sid, limit: "5" });
    if (include_body) params.set("body-format", "storage");
    const data = await atlassianFetch(auth, `/wiki/api/v2/pages?${params}`) as
      | { results?: Array<Record<string, unknown>>; error?: string };
    if (!Array.isArray(data?.results)) return JSON.stringify(data);
    return JSON.stringify({
      matches: data.results.map((p) => {
        const links = p._links as Record<string, unknown> | undefined;
        const webui = links?.webui as string | undefined;
        const body = p.body as Record<string, Record<string, unknown> | undefined> | undefined;
        return {
          id: p.id,
          title: p.title,
          space_id: p.spaceId,
          parent_id: p.parentId ?? null,
          status: p.status,
          url: webui ? `${auth.url}/wiki${webui}` : null,
          ...(include_body
            ? { body_storage: ((body?.storage?.value as string | undefined) ?? "").slice(0, 20_000) }
            : {}),
        };
      }),
    });
  },
  {
    name: "confluence_get_page_by_title",
    description:
      "Find Confluence page(s) by exact title within a space. Auto-resolves `space_key` (e.g. 'ENG') " +
      "to the v2 space id. Returns up to 5 matches; pass `include_body: true` to also include storage XHTML.",
    schema: z.object({
      space_key: z.string().describe("Space key like 'ENG'"),
      title: z.string().describe("Exact page title (case-sensitive on Cloud)"),
      include_body: z.boolean().optional(),
    }),
  },
);

export const confluenceGetPageChildrenTool = tool(
  async ({ page_id, cursor, limit }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const params = new URLSearchParams({ limit: String(Math.min(limit ?? 25, 250)) });
    if (cursor) params.set("cursor", cursor);
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/pages/${encodeURIComponent(page_id)}/children?${params}`,
    ) as { results?: Array<Record<string, unknown>>; _links?: { next?: string }; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      children: (data.results ?? []).map((p) => ({
        id: p.id,
        title: p.title,
        type: p.type,
        status: p.status,
        parent_id: p.parentId ?? null,
        position: p.position ?? null,
      })),
      next_cursor: parseV2NextCursor(data._links?.next),
    });
  },
  {
    name: "confluence_get_page_children",
    description:
      "List direct children of a Confluence page (cursor-paginated). Pass `cursor` from a prior call's " +
      "`next_cursor` to fetch the next page. Default limit 25 (max 250).",
    schema: z.object({
      page_id: z.string(),
      cursor: z.string().optional(),
      limit: z.number().optional(),
    }),
  },
);

export const confluenceGetPageAncestorsTool = tool(
  async ({ page_id }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/pages/${encodeURIComponent(page_id)}/ancestors`,
    ) as { results?: Array<Record<string, unknown>>; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ancestors: (data.results ?? []).map((a) => ({ id: a.id, title: a.title, type: a.type })),
    });
  },
  {
    name: "confluence_get_page_ancestors",
    description:
      "Return the parent chain (root → leaf) for a Confluence page. Useful for breadcrumbs and " +
      "understanding where a page lives in the tree.",
    schema: z.object({ page_id: z.string() }),
  },
);

export const confluenceListSpacesTool = tool(
  async ({ cursor, limit, type, status }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const params = new URLSearchParams({ limit: String(Math.min(limit ?? 25, 250)) });
    if (cursor) params.set("cursor", cursor);
    if (type) params.set("type", type);
    if (status) params.set("status", status);
    const data = await atlassianFetch(auth, `/wiki/api/v2/spaces?${params}`) as
      | { results?: Array<Record<string, unknown>>; _links?: { next?: string }; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      spaces: (data.results ?? []).map((s) => ({
        id: s.id,
        key: s.key,
        name: s.name,
        type: s.type,
        status: s.status,
        homepage_id: s.homepageId ?? null,
      })),
      next_cursor: parseV2NextCursor(data._links?.next),
    });
  },
  {
    name: "confluence_list_spaces",
    description:
      "List Confluence spaces (cursor-paginated). Returns id, key, name, type, status, homepage_id. " +
      "Useful for discovering space keys to pass to confluence_create_page or confluence_get_page_by_title.",
    schema: z.object({
      cursor: z.string().optional(),
      limit: z.number().optional(),
      type: z.enum(["global", "personal", "collaboration", "knowledge_base"]).optional(),
      status: z.enum(["current", "archived"]).optional(),
    }),
  },
);

export const confluenceGetCommentsTool = tool(
  async ({ page_id, include_inline }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const footerData = await atlassianFetch(
      auth,
      `/wiki/api/v2/pages/${encodeURIComponent(page_id)}/footer-comments?body-format=storage&limit=100`,
    ) as { results?: Array<Record<string, unknown>>; error?: string };
    let inlineData: { results?: Array<Record<string, unknown>>; error?: string } | undefined;
    if (include_inline !== false) {
      // Known v2 bug: some sites 404 here even when comments exist. Tolerate
      // and surface as `inline_warning` so the caller still gets footer comments.
      inlineData = await atlassianFetch(
        auth,
        `/wiki/api/v2/pages/${encodeURIComponent(page_id)}/inline-comments?body-format=storage&limit=100`,
      ) as { results?: Array<Record<string, unknown>>; error?: string };
    }
    if (footerData.error && !Array.isArray(footerData.results)) return JSON.stringify(footerData);
    const flatten = (c: Record<string, unknown>) => {
      const ver = c.version as Record<string, unknown> | undefined;
      const body = c.body as Record<string, Record<string, unknown> | undefined> | undefined;
      return {
        id: c.id,
        version: ver?.number ?? null,
        author_id: c.authorId ?? ver?.authorId ?? null,
        created_at: ver?.createdAt ?? null,
        body_storage: (body?.storage?.value as string | undefined) ?? null,
        parent_comment_id: c.parentCommentId ?? null,
      };
    };
    return JSON.stringify({
      footer_comments: (footerData.results ?? []).map(flatten),
      inline_comments: inlineData && Array.isArray(inlineData.results) ? inlineData.results.map(flatten) : [],
      ...(inlineData && inlineData.error ? { inline_warning: inlineData.error } : {}),
    });
  },
  {
    name: "confluence_get_comments",
    description:
      "List footer comments (and inline comments by default) on a Confluence page. Returns id, " +
      "version, author_id, created_at, body_storage, parent_comment_id (for threading). Tolerates " +
      "the known v2 inline-comments 404 bug — surfaces it as `inline_warning` rather than failing.",
    schema: z.object({
      page_id: z.string(),
      include_inline: z.boolean().optional().describe("Default true; pass false to skip inline-comments."),
    }),
  },
);

export const confluenceListAttachmentsTool = tool(
  async ({ page_id, cursor, limit }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const params = new URLSearchParams({ limit: String(Math.min(limit ?? 50, 250)) });
    if (cursor) params.set("cursor", cursor);
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/pages/${encodeURIComponent(page_id)}/attachments?${params}`,
    ) as { results?: Array<Record<string, unknown>>; _links?: { next?: string }; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      attachments: (data.results ?? []).map((a) => {
        const ver = a.version as Record<string, unknown> | undefined;
        const links = a._links as Record<string, unknown> | undefined;
        return {
          id: a.id,
          title: a.title,
          media_type: a.mediaType,
          file_size: a.fileSize ?? null,
          created_at: ver?.createdAt ?? null,
          download_link: a.downloadLink ?? null,
          webui_link: links?.webui ?? null,
        };
      }),
      next_cursor: parseV2NextCursor(data._links?.next),
    });
  },
  {
    name: "confluence_list_attachments",
    description:
      "List attachments on a Confluence page (cursor-paginated). Returns id, title, media_type, " +
      "file_size, download_link. Use confluence_get_attachment_content with the download_link to " +
      "fetch bytes.",
    schema: z.object({
      page_id: z.string(),
      cursor: z.string().optional(),
      limit: z.number().optional(),
    }),
  },
);

export const confluenceGetLabelsTool = tool(
  async ({ page_id, cursor, limit }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const params = new URLSearchParams({ limit: String(Math.min(limit ?? 50, 250)) });
    if (cursor) params.set("cursor", cursor);
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/pages/${encodeURIComponent(page_id)}/labels?${params}`,
    ) as { results?: Array<Record<string, unknown>>; _links?: { next?: string }; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      labels: (data.results ?? []).map((l) => ({ id: l.id, name: l.name, prefix: l.prefix })),
      next_cursor: parseV2NextCursor(data._links?.next),
    });
  },
  {
    name: "confluence_get_labels",
    description: "List labels on a Confluence page (cursor-paginated). Default limit 50 (max 250).",
    schema: z.object({
      page_id: z.string(),
      cursor: z.string().optional(),
      limit: z.number().optional(),
    }),
  },
);

export const confluenceGetAttachmentContentTool = tool(
  async ({ download_link, as_text }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    // download_link from v2 is typically `/download/attachments/{pageId}/{filename}?...`
    // — under the /wiki app, NOT under the bare auth.url. Build the absolute URL
    // explicitly because atlassianFetch's plain `${auth.url}${path}` join would
    // miss the /wiki prefix.
    const fullUrl = download_link.startsWith("http")
      ? download_link
      : download_link.startsWith("/wiki")
        ? `${auth.url}${download_link}`
        : `${auth.url}/wiki${download_link.startsWith("/") ? "" : "/"}${download_link}`;
    const res = await fetch(fullUrl, { headers: { Authorization: authHeader(auth) } });
    if (!res.ok) {
      const errText = await res.text();
      return JSON.stringify({ error: `Atlassian ${res.status}: ${errText.slice(0, 500)}` });
    }
    const ct = res.headers.get("content-type") ?? "";
    const looksText = as_text === true
      || (as_text !== false && /^(text\/|application\/(json|xml|yaml|x-yaml))/i.test(ct));
    if (looksText) {
      const text = await res.text();
      return JSON.stringify({
        content_type: ct,
        size: text.length,
        as: "text",
        content: text.slice(0, 50_000),
        truncated: text.length > 50_000,
      });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return JSON.stringify({
      content_type: ct,
      size: buf.length,
      as: "base64",
      content: buf.toString("base64"),
    });
  },
  {
    name: "confluence_get_attachment_content",
    description:
      "Fetch an attachment's bytes by its download_link (from confluence_list_attachments). Returns " +
      "UTF-8 text (capped at 50KB) for text-like content types, or base64 for binary. Override the " +
      "auto-detection via `as_text`.",
    schema: z.object({
      download_link: z.string().describe("download_link from confluence_list_attachments"),
      as_text: z.boolean().optional().describe(
        "Force text decode (true) or binary base64 (false). Default: auto-detect by content-type.",
      ),
    }),
  },
);

export const confluenceCreatePageTool = tool(
  async ({ space_key, title, parent_id, body_text, body_storage }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const sid = await resolveSpaceId(auth, space_key);
    if (typeof sid !== "string") return JSON.stringify(sid);
    const body = resolveBody({ body_text, body_storage });
    if ("error" in body) return JSON.stringify(body);
    const payload: Record<string, unknown> = {
      spaceId: sid,
      status: "current",
      title,
      body: { representation: body.representation, value: body.value },
    };
    if (parent_id) payload.parentId = parent_id;
    const data = await atlassianFetch(auth, `/wiki/api/v2/pages`, {
      method: "POST",
      body: JSON.stringify(payload),
    }) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    const links = data._links as Record<string, unknown> | undefined;
    const webui = links?.webui as string | undefined;
    return JSON.stringify({
      ok: true,
      id: data.id,
      title: data.title,
      space_id: data.spaceId,
      parent_id: data.parentId ?? null,
      version: (data.version as Record<string, unknown> | undefined)?.number ?? 1,
      url: webui ? `${auth.url}/wiki${webui}` : null,
    });
  },
  {
    name: "confluence_create_page",
    description:
      "Create a Confluence page (v2). Pass `space_key` (e.g. 'ENG') — auto-resolved to v2 spaceId. " +
      "Pass exactly one of `body_text` (plain text → storage XHTML automatically) or `body_storage` " +
      "(raw XHTML for advanced edits). `parent_id` makes it a child page. " +
      "Disable to make the agent unable to author Confluence pages.",
    schema: z.object({
      space_key: z.string(),
      title: z.string(),
      parent_id: z.string().optional().describe("Page id of the parent; omit for top-level."),
      body_text: z.string().optional().describe("Plain text; auto-converted to storage XHTML."),
      body_storage: z.string().optional().describe("Raw Confluence storage-format XHTML."),
    }),
  },
);

export const confluenceUpdatePageTool = tool(
  async ({ page_id, title, body_text, body_storage, version_number, version_message }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const body = resolveBody({ body_text, body_storage });
    if ("error" in body) return JSON.stringify(body);

    let nextVersion = version_number;
    let resolvedTitle: string | undefined = title;
    if (nextVersion === undefined || resolvedTitle === undefined) {
      // PUT requires both title and version even when not changing them, so
      // fetch the current page when either is omitted. Cheaper than asking
      // every caller to do it.
      const current = await atlassianFetch(
        auth,
        `/wiki/api/v2/pages/${encodeURIComponent(page_id)}`,
      ) as { title?: string; version?: { number?: number }; error?: string };
      if (current.error) return JSON.stringify(current);
      if (nextVersion === undefined) {
        const cur = current.version?.number;
        if (typeof cur !== "number") return JSON.stringify({ error: "could not read current version from Confluence response" });
        nextVersion = cur + 1;
      }
      if (resolvedTitle === undefined) resolvedTitle = current.title;
    }

    const payload: Record<string, unknown> = {
      id: page_id,
      status: "current",
      title: resolvedTitle,
      body: { representation: body.representation, value: body.value },
      version: { number: nextVersion, ...(version_message ? { message: version_message } : {}) },
    };
    const data = await atlassianFetch(auth, `/wiki/api/v2/pages/${encodeURIComponent(page_id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    const links = data._links as Record<string, unknown> | undefined;
    const webui = links?.webui as string | undefined;
    return JSON.stringify({
      ok: true,
      id: data.id,
      title: data.title,
      version: (data.version as Record<string, unknown> | undefined)?.number ?? nextVersion,
      url: webui ? `${auth.url}/wiki${webui}` : null,
    });
  },
  {
    name: "confluence_update_page",
    description:
      "Update an existing Confluence page (v2). Pass exactly one of `body_text` or `body_storage`. " +
      "If `version_number` is omitted, the tool auto-fetches the current version and sends current+1 " +
      "(Confluence requires strict +1 increments; gaps cause 409). If `title` is omitted, the existing " +
      "title is preserved. Avoid back-to-back updates within ~1 second — Confluence may return 409 even " +
      "with the correct version. Disable to make the agent read-only on pages.",
    schema: z.object({
      page_id: z.string(),
      title: z.string().optional().describe("New title; omit to keep existing."),
      body_text: z.string().optional(),
      body_storage: z.string().optional(),
      version_number: z.number().optional().describe(
        "Explicit version (must equal currentVersion+1). Omit to auto-fetch and increment.",
      ),
      version_message: z.string().optional().describe("Optional change comment shown in version history."),
    }),
  },
);

export const confluenceAddCommentTool = tool(
  async ({ page_id, body_text, body_storage, parent_comment_id }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const body = resolveBody({ body_text, body_storage });
    if ("error" in body) return JSON.stringify(body);
    const payload: Record<string, unknown> = {
      pageId: page_id,
      body: { representation: body.representation, value: body.value },
    };
    if (parent_comment_id) payload.parentCommentId = parent_comment_id;
    const data = await atlassianFetch(auth, `/wiki/api/v2/footer-comments`, {
      method: "POST",
      body: JSON.stringify(payload),
    }) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      comment_id: data.id,
      page_id,
      parent_comment_id: data.parentCommentId ?? null,
    });
  },
  {
    name: "confluence_add_comment",
    description:
      "Add a footer comment to a Confluence page (v2). Pass exactly one of `body_text` or " +
      "`body_storage`. Pass `parent_comment_id` (from confluence_get_comments) to reply in a thread.",
    schema: z.object({
      page_id: z.string(),
      body_text: z.string().optional(),
      body_storage: z.string().optional(),
      parent_comment_id: z.string().optional().describe("To reply to an existing comment."),
    }),
  },
);

export const confluenceMovePageTool = tool(
  async ({ page_id, position, target_id }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/pages/${encodeURIComponent(page_id)}/move/${encodeURIComponent(position)}/${encodeURIComponent(target_id)}`,
      { method: "PUT" },
    ) as { error?: string } | string | Record<string, unknown>;
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, page_id, position, target_id });
  },
  {
    name: "confluence_move_page",
    description:
      "Reorder/reparent a Confluence page (v2). `position`: 'before' or 'after' to place as a sibling " +
      "of `target_id`; 'append' to make it a child of `target_id`. Non-destructive.",
    schema: z.object({
      page_id: z.string(),
      position: z.enum(["before", "after", "append"]),
      target_id: z.string().describe("Sibling (for before/after) or new parent (for append)."),
    }),
  },
);

export const confluenceUploadAttachmentTool = tool(
  async ({ page_id, filename, content_base64, content_text, comment, minor_edit }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (!content_base64 && !content_text) {
      return JSON.stringify({ error: "pass either content_base64 (binary) or content_text (UTF-8)" });
    }
    const buf = content_base64
      ? Buffer.from(content_base64, "base64")
      : Buffer.from(content_text!, "utf8");

    // v1 fallback: v2 Attachment group is read-only as of 2026 (CONFCLOUD-77196).
    // Same multipart shape as jiraUploadAttachmentTool — X-Atlassian-Token: no-check
    // bypasses CSRF; do NOT set Content-Type (fetch fills in the multipart boundary).
    const form = new FormData();
    form.append("file", new Blob([buf]), filename);
    if (typeof comment === "string") form.append("comment", comment);
    if (minor_edit) form.append("minorEdit", "true");

    const url = `${auth.url}/wiki/rest/api/content/${encodeURIComponent(page_id)}/child/attachment`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authHeader(auth),
        Accept: "application/json",
        "X-Atlassian-Token": "no-check",
      },
      body: form,
    });
    const text = await res.text();
    if (!res.ok) return JSON.stringify({ error: `Atlassian ${res.status}: ${text.slice(0, 500)}` });
    const parsed = parseJsonSafe<{
      results?: Array<{ id: string; title: string; metadata?: { mediaType?: string }; extensions?: { fileSize?: number } }>;
    }>(text, {});
    return JSON.stringify({
      ok: true,
      page_id,
      attachments: (parsed.results ?? []).map((a) => ({
        id: a.id,
        title: a.title,
        media_type: a.metadata?.mediaType ?? null,
        file_size: a.extensions?.fileSize ?? null,
      })),
    });
  },
  {
    name: "confluence_upload_attachment",
    description:
      "Attach a file to a Confluence page. Pass content_base64 for binary or content_text for plain " +
      "UTF-8. Uses the v1 multipart endpoint (v2 has no attachment-create endpoint as of 2026). " +
      "Disable to make the agent unable to add attachments.",
    schema: z.object({
      page_id: z.string(),
      filename: z.string().describe("Filename shown in Confluence (include the extension)."),
      content_base64: z.string().optional().describe("Base64-encoded file contents (use for binary)."),
      content_text: z.string().optional().describe("Raw UTF-8 text contents (use for logs/CSVs/JSON)."),
      comment: z.string().optional().describe("Version comment shown in the attachment history."),
      minor_edit: z.boolean().optional().describe("If true, doesn't notify watchers."),
    }),
  },
);

export const confluenceAddLabelTool = tool(
  async ({ page_id, labels }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (!labels.length) return JSON.stringify({ error: "labels is empty" });
    // v1 fallback: v2 Label group is read-only as of 2026 (CONFCLOUD-76866).
    const payload = labels.map((name) => ({ prefix: "global", name }));
    const data = await atlassianFetch(
      auth,
      `/wiki/rest/api/content/${encodeURIComponent(page_id)}/label`,
      { method: "POST", body: JSON.stringify(payload) },
    ) as { results?: Array<{ name?: string; prefix?: string }>; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      page_id,
      added: labels,
      total_labels: (data.results ?? []).map((r) => r.name).filter(Boolean),
    });
  },
  {
    name: "confluence_add_label",
    description:
      "Add one or more labels to a Confluence page (additive — does not replace existing labels). " +
      "Uses the v1 endpoint (v2 only reads labels as of 2026).",
    schema: z.object({
      page_id: z.string(),
      labels: z.array(z.string()).describe("Label names to add (e.g. ['runbook', 'on-call'])."),
    }),
  },
);

// ── Confluence v2 gap-fillers (ADR-0035) ────────────────────────────────────
//
// v2 audit on 2026-05-28 confirmed:
//   - DELETE /pages/{id} exists (with optional purge=true).
//   - PUT/DELETE /footer-comments/{id} and /inline-comments/{id} exist.
//   - DELETE /attachments/{id} exists (with optional purge=true).
//   - Label group is STILL read-only (CONFCLOUD-76866); confluence_remove_label
//     uses the v1 fallback `DELETE /content/{id}/label?name=...`.

export const confluenceDeletePageTool = tool(
  async ({ page_id, purge, confirm }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (purge && confirm !== page_id) {
      return JSON.stringify({
        error:
          `Refusing to permanently delete page ${page_id}: purge=true requires confirm to equal page_id. ` +
          `A purged page cannot be restored from trash. Drop purge if you only want to soft-delete.`,
      });
    }
    const qs = purge ? `?purge=true` : "";
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/pages/${encodeURIComponent(page_id)}${qs}`,
      { method: "DELETE" },
    ) as { error?: string } | string;
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, deleted_page_id: page_id, purged: !!purge });
  },
  {
    name: "confluence_delete_page",
    description:
      "Delete a Confluence page (v2). Default soft-deletes (page goes to trash, restorable). " +
      "Pass purge=true for permanent deletion, which **also requires `confirm` to equal page_id** " +
      "as a guardrail. Disable to make the agent unable to delete pages.",
    schema: z.object({
      page_id: z.string(),
      purge: z.boolean().optional().describe("If true, permanently delete (skip trash). Requires confirm=page_id."),
      confirm: z.string().optional().describe("Required when purge=true; must equal page_id."),
    }),
  },
);

const COMMENT_KIND_TO_PATH: Record<string, string> = {
  footer: "footer-comments",
  inline: "inline-comments",
};

export const confluenceUpdateCommentTool = tool(
  async ({ comment_id, kind, body_text, body_storage, version_number, version_message }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const segment = COMMENT_KIND_TO_PATH[kind];
    if (!segment) {
      return JSON.stringify({ error: `unknown kind "${kind}". Expected 'footer' or 'inline'.` });
    }
    const body = resolveBody({ body_text, body_storage });
    if ("error" in body) return JSON.stringify(body);

    let nextVersion = version_number;
    if (nextVersion === undefined) {
      // PUT requires version.number = current + 1; auto-fetch when not passed.
      const current = await atlassianFetch(
        auth,
        `/wiki/api/v2/${segment}/${encodeURIComponent(comment_id)}`,
      ) as { version?: { number?: number }; error?: string };
      if (current.error) return JSON.stringify(current);
      const cur = current.version?.number;
      if (typeof cur !== "number") return JSON.stringify({ error: "could not read current comment version" });
      nextVersion = cur + 1;
    }

    const payload: Record<string, unknown> = {
      version: { number: nextVersion, ...(version_message ? { message: version_message } : {}) },
      body: { representation: body.representation, value: body.value },
    };
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/${segment}/${encodeURIComponent(comment_id)}`,
      { method: "PUT", body: JSON.stringify(payload) },
    ) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      comment_id,
      kind,
      version: (data.version as Record<string, unknown> | undefined)?.number ?? nextVersion,
    });
  },
  {
    name: "confluence_update_comment",
    description:
      "Edit an existing Confluence comment (v2). Pass `kind: 'footer' | 'inline'` to route to the " +
      "correct endpoint. Same `body_text` xor `body_storage` pattern as confluence_add_comment. If " +
      "version_number is omitted, the tool auto-fetches the current version and sends current+1 " +
      "(Confluence requires strict +1 increments).",
    schema: z.object({
      comment_id: z.string(),
      kind: z.enum(["footer", "inline"]),
      body_text: z.string().optional(),
      body_storage: z.string().optional(),
      version_number: z.number().optional().describe("Explicit version (must be current+1). Omit to auto-fetch."),
      version_message: z.string().optional(),
    }),
  },
);

export const confluenceDeleteCommentTool = tool(
  async ({ comment_id, kind }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const segment = COMMENT_KIND_TO_PATH[kind];
    if (!segment) {
      return JSON.stringify({ error: `unknown kind "${kind}". Expected 'footer' or 'inline'.` });
    }
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/${segment}/${encodeURIComponent(comment_id)}`,
      { method: "DELETE" },
    ) as { error?: string } | string;
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, deleted_comment_id: comment_id, kind });
  },
  {
    name: "confluence_delete_comment",
    description:
      "Permanently delete a Confluence comment (v2). Pass `kind: 'footer' | 'inline'`. **Destructive — " +
      "no undo.** Disable to make the agent unable to delete comments.",
    schema: z.object({
      comment_id: z.string(),
      kind: z.enum(["footer", "inline"]),
    }),
  },
);

export const confluenceRemoveLabelTool = tool(
  async ({ page_id, label }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    // v1 fallback — v2 Label group is read-only as of 2026-05-28 (CONFCLOUD-76866).
    // The v1 endpoint accepts the label name as a query param; the prefix
    // defaults to "global" which is what confluence_add_label uses.
    const data = await atlassianFetch(
      auth,
      `/wiki/rest/api/content/${encodeURIComponent(page_id)}/label?name=${encodeURIComponent(label)}`,
      { method: "DELETE" },
    ) as { error?: string } | string;
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, page_id, removed_label: label });
  },
  {
    name: "confluence_remove_label",
    description:
      "Remove a single label from a Confluence page. Uses the v1 endpoint (v2 Label group is still " +
      "read-only as of 2026). Counterpart to confluence_add_label.",
    schema: z.object({
      page_id: z.string(),
      label: z.string().describe("Label name to remove (no prefix; we always use 'global')"),
    }),
  },
);

export const confluenceDeleteAttachmentTool = tool(
  async ({ attachment_id, purge, confirm }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (purge && confirm !== attachment_id) {
      return JSON.stringify({
        error:
          `Refusing to permanently delete attachment ${attachment_id}: purge=true requires confirm to equal attachment_id. ` +
          `A purged attachment cannot be restored.`,
      });
    }
    const qs = purge ? `?purge=true` : "";
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/attachments/${encodeURIComponent(attachment_id)}${qs}`,
      { method: "DELETE" },
    ) as { error?: string } | string;
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, deleted_attachment_id: attachment_id, purged: !!purge });
  },
  {
    name: "confluence_delete_attachment",
    description:
      "Delete a Confluence attachment by id (v2). Default soft-deletes (trash, restorable). Pass " +
      "purge=true for permanent deletion, which **also requires `confirm` to equal attachment_id** " +
      "as a guardrail.",
    schema: z.object({
      attachment_id: z.string(),
      purge: z.boolean().optional(),
      confirm: z.string().optional().describe("Required when purge=true; must equal attachment_id."),
    }),
  },
);
