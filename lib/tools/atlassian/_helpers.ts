// Shared helpers used by Jira + Confluence tools. Split out of the
// monolithic lib/tools/atlassian.ts in the bloat-audit refactor. Public
// surface (confluenceTextToStorage, parseV2NextCursor, JiraFieldDef,
// resolveCustomFieldNames, extractFieldValue) is re-exported from
// lib/tools/atlassian.ts so existing tests/imports keep working.

import type { AtlassianAuth } from "./_auth";
import { atlassianFetch } from "./_auth";

// Convert plain text → Confluence storage-format XHTML. Splits on blank lines
// for paragraphs and uses <br/> for single newlines. Escapes &, <, > because
// Confluence storage rejects unescaped ampersands and stray angle brackets.
// Pure — exported for unit testing.
export function confluenceTextToStorage(text: string): string {
  if (text.length === 0) return "<p></p>";
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${para.split("\n").map(escape).join("<br/>")}</p>`)
    .join("");
}

// Extract the opaque cursor query param from a Confluence v2 `_links.next` URL.
// v2 cursors are not safe to construct — Atlassian explicitly says "always parse
// the next link, never build it". Pure — exported for unit testing.
export function parseV2NextCursor(linksNext: string | undefined): string | null {
  if (!linksNext) return null;
  const m = linksNext.match(/[?&]cursor=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Body input dispatcher used by create_page / update_page / add_comment.
// Callers pass body_text XOR body_storage; this resolves to the wire format
// or a structured error for the LLM. body_storage is rejected if it contains
// <script>/<style> — Confluence storage rejects those with opaque 400s, so
// catch it here with a useful message.
export function resolveBody(input: { body_text?: string; body_storage?: string }):
  | { value: string; representation: "storage" }
  | { error: string }
{
  const hasText = typeof input.body_text === "string";
  const hasStorage = typeof input.body_storage === "string";
  if (hasText && hasStorage) {
    return { error: "pass exactly one of body_text or body_storage, not both" };
  }
  if (!hasText && !hasStorage) {
    return { error: "pass exactly one of body_text or body_storage" };
  }
  if (hasStorage) {
    const s = input.body_storage!;
    if (/<\s*(script|style)[\s>]/i.test(s)) {
      return { error: "body_storage rejected: <script>/<style> tags are not allowed by Confluence storage format" };
    }
    return { value: s, representation: "storage" };
  }
  return { value: confluenceTextToStorage(input.body_text!), representation: "storage" };
}

// Per-site cache of space key → numeric space id. v2 page endpoints take
// spaceId, but humans (and the LLM) think in space keys. 1h TTL mirrors
// loadJiraFields below.
const SPACE_ID_CACHE_TTL_MS = 60 * 60 * 1000;
const spaceIdCache = new Map<string, { id: string; loaded: number }>();

export async function resolveSpaceId(
  auth: AtlassianAuth,
  spaceKey: string,
): Promise<string | { error: string }> {
  const cacheKey = `${auth.url}|${spaceKey}`;
  const cached = spaceIdCache.get(cacheKey);
  if (cached && Date.now() - cached.loaded < SPACE_ID_CACHE_TTL_MS) return cached.id;
  const data = await atlassianFetch(
    auth,
    `/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}&limit=1`,
  ) as { results?: Array<{ id: string; key: string }>; error?: string };
  if ("error" in data && data.error) return { error: data.error };
  const hit = (data.results ?? []).find((s) => s.key === spaceKey) ?? data.results?.[0];
  if (!hit?.id) return { error: `space key "${spaceKey}" not found` };
  spaceIdCache.set(cacheKey, { id: hit.id, loaded: Date.now() });
  return hit.id;
}

// Per-site cache of /rest/api/3/field. Custom field IDs are stable per site,
// but display names can be edited; 1h TTL keeps us fresh without thrashing.
export interface JiraFieldDef { id: string; name: string; custom: boolean }
const FIELD_CACHE_TTL_MS = 60 * 60 * 1000;
const fieldCache = new Map<string, { fields: JiraFieldDef[]; loaded: number }>();

export async function loadJiraFields(auth: AtlassianAuth): Promise<JiraFieldDef[] | { error: string }> {
  const cached = fieldCache.get(auth.url);
  if (cached && Date.now() - cached.loaded < FIELD_CACHE_TTL_MS) return cached.fields;
  const data = await atlassianFetch(auth, `/rest/api/3/field`) as
    | Array<{ id: string; name: string; custom: boolean }>
    | { error?: string };
  if (!Array.isArray(data)) return data as { error: string };
  const fields = data.map((f) => ({ id: f.id, name: f.name, custom: f.custom }));
  fieldCache.set(auth.url, { fields, loaded: Date.now() });
  return fields;
}

// Pure helper — exported for unit testing. Given a list of caller inputs and
// the site's field definitions, partition into resolved (matched by id or
// case-insensitive display name) and unresolved.
export function resolveCustomFieldNames(
  inputs: string[],
  fields: JiraFieldDef[],
): { resolved: Array<{ input: string; id: string; name: string }>; unresolved: string[] } {
  const byId = new Map<string, JiraFieldDef>();
  const byName = new Map<string, JiraFieldDef>();
  for (const f of fields) {
    byId.set(f.id, f);
    byName.set(f.name.toLowerCase(), f);
  }
  const resolved: Array<{ input: string; id: string; name: string }> = [];
  const unresolved: string[] = [];
  for (const input of inputs) {
    const trimmed = input.trim();
    const hit = byId.get(trimmed) ?? byName.get(trimmed.toLowerCase());
    if (hit) resolved.push({ input, id: hit.id, name: hit.name });
    else unresolved.push(input);
  }
  return { resolved, unresolved };
}

// Coerce a Jira field value (which can be string, number, ADF doc, option
// object, user object, array of those) into something an LLM can read. When
// Jira returns a renderedFields HTML version, prefer that — it's the author's
// formatting, flattened.
export function extractFieldValue(raw: unknown, renderedHTML: unknown): unknown {
  if (typeof renderedHTML === "string" && renderedHTML.length > 0) {
    return stripHtml(renderedHTML);
  }
  if (raw == null) return null;
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
  if (Array.isArray(raw)) return raw.map(coerceItem);
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (obj.type === "doc" && Array.isArray(obj.content)) return simplifyADF(obj);
    if (typeof obj.value === "string") return obj.value;
    if (typeof obj.displayName === "string") return obj.displayName;
    if (typeof obj.name === "string") return obj.name;
    return obj;
  }
  return raw;
}

export function coerceItem(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const obj = item as Record<string, unknown>;
  if (typeof obj.value === "string") return obj.value;
  if (typeof obj.name === "string") return obj.name;
  if (typeof obj.displayName === "string") return obj.displayName;
  return obj;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Atlassian's REST API takes ADF (Atlassian Document Format), not plain text.
// This wraps a plain string so the agent doesn't have to know the schema.
export function textToADF(text: string): unknown {
  type ADFNode = { type: string; text?: string };
  return {
    type: "doc",
    version: 1,
    content: text.split(/\n\n+/).map((para) => ({
      type: "paragraph",
      content: para.split("\n").flatMap<ADFNode>((line, i) =>
        i === 0
          ? [{ type: "text", text: line }]
          : [{ type: "hardBreak" }, { type: "text", text: line }],
      ),
    })),
  };
}

// Best-effort flatten of an ADF document back to plain text. Doesn't preserve
// formatting but gives the agent something readable to summarize.
export function simplifyADF(adf: unknown): string {
  if (!adf || typeof adf !== "object") return typeof adf === "string" ? adf : "";
  const out: string[] = [];
  walk(adf);
  return out.join("").trim();

  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n.type === "text" && typeof n.text === "string") out.push(n.text);
    if (n.type === "hardBreak") out.push("\n");
    if (n.type === "paragraph") { walkChildren(n.content); out.push("\n\n"); }
    else if (n.type === "bulletList" || n.type === "orderedList") walkChildren(n.content);
    else if (n.type === "listItem") { out.push("• "); walkChildren(n.content); }
    else walkChildren(n.content);
  }
  function walkChildren(children: unknown): void {
    if (Array.isArray(children)) for (const c of children) walk(c);
  }
}
