import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  createDocumentSource,
  getDocumentSourceByPath,
  getDocumentSourceStats,
  listDocumentSources,
  type DocumentSourceKind,
} from "@/lib/stores/document-sources";
import { notifyTriggerHandlers } from "@/lib/triggers";

const LocalSchema = z.object({
  path: z.string().min(1),
  label: z.string().nullable().optional(),
});

// ADR-0026 — remote source kinds (Jira/Confluence) share the same store
// and indexer pipeline. A separate body shape keeps the local-folder
// happy path identical to pre-0026.
const REMOTE_KINDS = [
  "confluence_space",
  "confluence_cql",
  "jira_project",
  "jira_jql",
  "github_pulls",
  "github_repo",
] as const;
const RemoteSchema = z.object({
  kind: z.enum(REMOTE_KINDS),
  label: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
});

function syntheticPath(kind: DocumentSourceKind, config: Record<string, unknown>): string {
  switch (kind) {
    case "confluence_space": return `confluence-space://${String(config.space_key ?? "")}`;
    case "confluence_cql":   return `confluence-cql://${Buffer.from(String(config.cql ?? "")).toString("base64").slice(0, 32)}`;
    case "jira_project":     return `jira-project://${String(config.project_key ?? "")}`;
    case "jira_jql":         return `jira-jql://${Buffer.from(String(config.jql ?? "")).toString("base64").slice(0, 32)}`;
    case "github_pulls":     return `github-pulls://${String(config.owner ?? "")}/${String(config.repo ?? "")}`;
    case "github_repo":      return `github-repo://${String(config.owner ?? "")}/${String(config.repo ?? "")}`;
    default: return `remote://${kind}/${Date.now()}`;
  }
}

function rowResponse(row: ReturnType<typeof createDocumentSource>) {
  return {
    id: row.id,
    path: row.path,
    label: row.label,
    enabled: row.enabled === 1,
    last_scan_at: row.last_scan_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    kind: row.kind,
    config: row.config ? JSON.parse(row.config) : null,
    stats: getDocumentSourceStats(row.id),
  };
}

export async function GET() {
  const sources = listDocumentSources();
  return NextResponse.json(
    sources.map((s) => ({
      id: s.id,
      path: s.path,
      label: s.label,
      enabled: s.enabled === 1,
      last_scan_at: s.last_scan_at,
      last_error: s.last_error,
      created_at: s.created_at,
      updated_at: s.updated_at,
      kind: s.kind,
      config: s.config ? JSON.parse(s.config) : null,
      stats: getDocumentSourceStats(s.id),
    })),
  );
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Remote source path — discriminated by `kind` being present (and
  // non-local). Local-folder POSTs that happen to include `kind:'local_folder'`
  // still flow through the local-folder branch below.
  if (body && typeof body === "object" && "kind" in (body as Record<string, unknown>)
      && (body as { kind?: string }).kind !== "local_folder") {
    const parsed = RemoteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid input" }, { status: 400 });
    }
    const synth = syntheticPath(parsed.data.kind, parsed.data.config);
    if (getDocumentSourceByPath(synth)) {
      return NextResponse.json({ error: "source already exists for this config" }, { status: 409 });
    }
    const row = createDocumentSource({
      path: synth,
      label: parsed.data.label,
      kind: parsed.data.kind,
      config: parsed.data.config,
    });
    await notifyTriggerHandlers("source_changed");
    return NextResponse.json(rowResponse(row), { status: 201 });
  }

  const parsed = LocalSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid input" }, { status: 400 });
  }
  const abs = path.resolve(parsed.data.path);

  try {
    const st = await fs.stat(abs);
    if (!st.isDirectory()) {
      return NextResponse.json({ error: "path is not a directory" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "path does not exist or is unreadable" }, { status: 400 });
  }

  if (getDocumentSourceByPath(abs)) {
    return NextResponse.json({ error: "source already exists for this path" }, { status: 409 });
  }

  const row = createDocumentSource({ path: abs, label: parsed.data.label ?? null });
  await notifyTriggerHandlers("source_changed");
  return NextResponse.json(rowResponse(row), { status: 201 });
}
