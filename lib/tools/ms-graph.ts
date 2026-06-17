/**
 * Microsoft Graph "core" toolkit: tools that aren't tied to a single
 * resource (mail / calendar / todo each have their own file). These sit
 * directly on top of the shared graphFetch + paging helpers from
 * lib/integrations/microsoft-oauth.ts.
 *
 * Three tools:
 *   - ms_graph_get          — escape hatch for arbitrary GET against
 *                             graph.microsoft.com/v1.0/<path>. The agent
 *                             can reach endpoints we haven't wrapped
 *                             (drive, teams, sites, insights, …) without
 *                             us writing a dedicated wrapper.
 *   - ms_search             — POST /search/query, Microsoft's
 *                             cross-workload search (mail, events,
 *                             driveItems, listItems, people, …). One
 *                             tool replaces N per-entity search tools.
 *   - ms_people_resolve     — GET /me/people?$search="…", a fuzzy
 *                             "who is X" lookup that returns slimmed
 *                             {name,email,jobTitle,relevanceScore} rows.
 *
 * All three reuse the same OAuth refresh, token cache, 401-retry, 429/503
 * backoff, and scope-aware 403 messages built into graphFetch.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { truncateBytes } from "@/lib/utils/text";
import { registerLangChainPackage } from "./langchain-package";
import {
  graphFetch,
  graphPaged,
  resolveMicrosoftAuth,
  type MicrosoftAuth,
} from "@/lib/integrations/microsoft-oauth";

// 60KB cap on response payloads. Mirrors the convention used in
// outlook.ts / outlook-calendar.ts so the agent's context stays bounded.
const MAX_RESPONSE_BYTES = 60_000;

function resolveAuth(): MicrosoftAuth | { error: string } {
  return resolveMicrosoftAuth();
}

function asJson(value: unknown): string {
  const text = JSON.stringify(value);
  return truncateBytes(text, MAX_RESPONSE_BYTES).text;
}

// ── ms_graph_get ───────────────────────────────────────────────────────────
// Generic read-only escape hatch. The agent supplies the relative path
// (`/me/drive/recent`, `/me/insights/used`, etc.) and an optional query
// dict. We refuse absolute hosts, refuse anything but GET (mutations have
// to go through the typed wrappers), and bound the page count.

const msGraphGetTool = tool(
  async (args) => {
    const { path, query, paginate, max_pages } = args as {
      path: string;
      query?: Record<string, string>;
      paginate?: boolean;
      max_pages?: number;
    };
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });

    const cleaned = path.startsWith("/") ? path : `/${path}`;
    if (cleaned.startsWith("/http") || cleaned.includes("://")) {
      return JSON.stringify({ error: "path must be a relative Graph path, not an absolute URL" });
    }

    let url = cleaned;
    if (query && Object.keys(query).length > 0) {
      const qs = new URLSearchParams(query).toString();
      url += (cleaned.includes("?") ? "&" : "?") + qs;
    }

    const result = paginate
      ? await graphPaged(auth, url, { maxPages: Math.min(Math.max(max_pages ?? 5, 1), 10) })
      : await graphFetch(auth, url);
    return asJson(result);
  },
  {
    name: "ms_graph_get",
    description:
      "GET arbitrary Microsoft Graph v1.0 endpoints. Use for endpoints not " +
      "covered by the dedicated Outlook/Calendar/To-Do/Search/People tools " +
      "(e.g. /me/drive/recent, /me/insights/shared, /me/manager, " +
      "/me/joinedTeams). path is RELATIVE to https://graph.microsoft.com/v1.0 " +
      "and MUST start with '/'. Query parameters go in `query`. Set " +
      "paginate=true to follow @odata.nextLink up to `max_pages` (default 5, " +
      "max 10) and return the merged `value[]` array.",
    schema: z.object({
      path: z
        .string()
        .min(2)
        .describe("Relative Graph path, e.g. '/me/drive/recent' or '/me/insights/shared'"),
      query: z
        .record(z.string(), z.string())
        .optional()
        .describe("Query-string parameters (e.g. { '$top': '10', '$select': 'id,name' })"),
      paginate: z.boolean().optional().describe("If true, follow @odata.nextLink"),
      max_pages: z.number().int().min(1).max(10).optional().describe("Cap pages when paginate=true"),
    }),
  },
);

// ── ms_search ──────────────────────────────────────────────────────────────
// Microsoft Search API: POST /search/query with one or more entityTypes.
// Default to the four most useful for productivity workflows. The agent
// can override the list (e.g. ["chatMessage"] for Teams). We slim the
// hits down to {kind,id,title,summary,url,lastModified}.

interface SearchHit {
  hitId?: string;
  rank?: number;
  summary?: string;
  resource?: {
    id?: string;
    subject?: string;
    bodyPreview?: string;
    name?: string;
    displayName?: string;
    webUrl?: string;
    webLink?: string;
    lastModifiedDateTime?: string;
    receivedDateTime?: string;
    start?: { dateTime?: string };
  };
}
interface SearchContainer {
  hitsContainers?: Array<{
    hits?: SearchHit[];
    total?: number;
    moreResultsAvailable?: boolean;
  }>;
  searchTerms?: string[];
}

function slimSearchHit(entityType: string, h: SearchHit): Record<string, unknown> {
  const r = h.resource ?? {};
  return {
    kind: entityType,
    id: r.id ?? h.hitId ?? null,
    title: r.subject ?? r.name ?? r.displayName ?? null,
    summary: h.summary ?? r.bodyPreview ?? null,
    url: r.webLink ?? r.webUrl ?? null,
    last_modified:
      r.lastModifiedDateTime ?? r.receivedDateTime ?? r.start?.dateTime ?? null,
    rank: h.rank ?? null,
  };
}

const msSearchTool = tool(
  async (args) => {
    const { query, entity_types, size } = args as {
      query: string;
      entity_types?: string[];
      size?: number;
    };
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });

    const entityTypes =
      entity_types && entity_types.length > 0
        ? entity_types
        : ["message", "event", "driveItem", "listItem"];
    const top = Math.min(Math.max(size ?? 10, 1), 25);

    const body = {
      requests: [
        {
          entityTypes,
          query: { queryString: query },
          from: 0,
          size: top,
        },
      ],
    };

    const result = (await graphFetch(auth, "/search/query", {
      method: "POST",
      body: JSON.stringify(body),
    })) as { value?: SearchContainer[]; error?: string };
    if (result && typeof result === "object" && "error" in result && result.error) {
      return JSON.stringify({ error: result.error });
    }

    const containers = result.value ?? [];
    const out: Array<Record<string, unknown>> = [];
    for (const c of containers) {
      for (const hc of c.hitsContainers ?? []) {
        for (const hit of hc.hits ?? []) {
          // Microsoft returns the entity type per container, not per hit,
          // but the @odata.type of resource is the canonical signal.
          const odata = (hit.resource as { "@odata.type"?: string } | undefined)?.[
            "@odata.type"
          ];
          const kind = odata?.split(".").pop() ?? entityTypes[0];
          out.push(slimSearchHit(kind, hit));
        }
      }
    }
    return asJson({ query, hits: out, count: out.length });
  },
  {
    name: "ms_search",
    description:
      "Search across Microsoft 365 workloads (mail, calendar events, OneDrive/SharePoint files, " +
      "lists, people, Teams chats) in one call via Microsoft Search. Returns slimmed hits with " +
      "{kind,id,title,summary,url,last_modified,rank}. Defaults to entity_types=" +
      "['message','event','driveItem','listItem']. Override entity_types for narrower searches " +
      "(e.g. ['chatMessage'] for Teams, ['person'] for people, ['site'] for SharePoint sites).",
    schema: z.object({
      query: z.string().min(1).describe("Free-text search query (KQL syntax supported)"),
      entity_types: z
        .array(
          z.enum([
            "message",
            "event",
            "driveItem",
            "listItem",
            "list",
            "site",
            "person",
            "chatMessage",
            "bookmark",
            "acronym",
            "qna",
          ]),
        )
        .optional()
        .describe("Which workloads to search. Default: message,event,driveItem,listItem"),
      size: z.number().int().min(1).max(25).optional().describe("Max hits to return (default 10)"),
    }),
  },
);

// ── ms_people_resolve ──────────────────────────────────────────────────────
// /me/people is Microsoft's ranked frequent-contacts list. $search does a
// fuzzy match across display name, email, and (where indexed) job title.
// Useful for "who is Sarah from finance" before composing an email or
// inviting an attendee.

interface GraphPerson {
  id?: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  jobTitle?: string;
  companyName?: string;
  department?: string;
  officeLocation?: string;
  scoredEmailAddresses?: Array<{ address?: string; relevanceScore?: number }>;
  phones?: Array<{ type?: string; number?: string }>;
}

function slimPerson(p: GraphPerson): Record<string, unknown> {
  const emails = (p.scoredEmailAddresses ?? [])
    .filter((e) => typeof e.address === "string" && e.address.length > 0)
    .map((e) => ({ address: e.address, score: e.relevanceScore ?? null }));
  const fallbackName = `${p.givenName ?? ""} ${p.surname ?? ""}`.trim();
  return {
    id: p.id ?? null,
    name: p.displayName ?? (fallbackName.length > 0 ? fallbackName : null),
    job_title: p.jobTitle ?? null,
    company: p.companyName ?? null,
    department: p.department ?? null,
    office: p.officeLocation ?? null,
    emails,
    phones: (p.phones ?? []).map((ph) => ph.number).filter(Boolean),
  };
}

const msPeopleResolveTool = tool(
  async (args) => {
    const { search, top } = args as { search: string; top?: number };
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });

    const limit = Math.min(Math.max(top ?? 5, 1), 25);
    const qs = new URLSearchParams({
      $search: `"${search}"`,
      $top: String(limit),
    }).toString();

    const result = (await graphFetch(auth, `/me/people?${qs}`)) as {
      value?: GraphPerson[];
      error?: string;
    };
    if (result && typeof result === "object" && "error" in result && result.error) {
      return JSON.stringify({ error: result.error });
    }
    const people = (result.value ?? []).map(slimPerson);
    return asJson({ query: search, count: people.length, people });
  },
  {
    name: "ms_people_resolve",
    description:
      "Resolve a partial name / handle / role description to actual Microsoft 365 contacts " +
      "via the /me/people relevance-ranked endpoint. Returns top matches with name, emails " +
      "(ranked by score), job title, company, department, and phones. Use BEFORE composing " +
      "Outlook mail or scheduling Calendar events when you only have a first name or a " +
      "fuzzy descriptor like 'Sarah in finance'.",
    schema: z.object({
      search: z.string().min(1).describe("Partial name, email, or role to fuzzy-match"),
      top: z.number().int().min(1).max(25).optional().describe("Max matches to return (default 5)"),
    }),
  },
);

registerLangChainPackage({
  category: "Microsoft",
  tools: {
    read: [msGraphGetTool, msSearchTool, msPeopleResolveTool],
  },
});
