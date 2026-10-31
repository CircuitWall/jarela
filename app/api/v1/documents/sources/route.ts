import { NextRequest, NextResponse } from "next/server";
import { localDocumentSourceSchema, remoteDocumentSourceSchema } from "@/api/document-sources";
import { createHash } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  createDocumentSource,
  getDocumentSourceByPath,
  getDocumentSourceStats,
  listDocumentSourcesWithStats,
  type DocumentSourceKind,
} from "@/lib/stores/document-sources";
import { notifyTriggerHandlers } from "@/lib/triggers";
import { mailSourceConfigSchema } from "@/lib/documents/mail-source-config";
import { errorResponse } from "@/lib/api/responses";
import { documentSourceToResponse } from "@/lib/api/serializers";

function syntheticPath(kind: DocumentSourceKind, config: Record<string, unknown>): string {
  const hash = Buffer.from(JSON.stringify({ kind, config })).toString("base64").replace(/=+$/g, "").slice(0, 24);
  switch (kind) {
    case "confluence_space": return `confluence-space://${String(config.space_key ?? "")}`;
    case "confluence_cql":   return `confluence-cql://${Buffer.from(String(config.cql ?? "")).toString("base64").slice(0, 32)}`;
    case "jira_project":     return `jira-project://${String(config.project_key ?? "")}`;
    case "jira_jql":         return `jira-jql://${Buffer.from(String(config.jql ?? "")).toString("base64").slice(0, 32)}`;
    case "github_pulls":     return `github-pulls://${String(config.owner ?? "")}/${String(config.repo ?? "")}`;
    case "github_repo":      return `github-repo://${String(config.owner ?? "")}/${String(config.repo ?? "")}`;
    case "gmail_mail":       return `gmail-mail://${hash}`;
    case "outlook_mail":     return `outlook-mail://${hash}`;
    case "icloud_mail":      return `icloud-mail://${hash}`;
    default: return `remote://${kind}/${Date.now()}`;
  }
}

export async function GET() {
  const sources = listDocumentSourcesWithStats();
  return NextResponse.json(
    sources.map(({ source, stats }) => documentSourceToResponse(source, stats)),
  );
}

/**
 * Create either a local folder source or a configured remote source.
 * Validates before persistence, preserves source identity conflict responses,
 * and notifies source-change handlers only after the row has been created.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch {
    return errorResponse("invalid json", 400);
  }
  let input: Parameters<typeof createDocumentSource>[0];
  let conflictMessage: string;

  // Remote source path — discriminated by `kind` being present (and
  // non-local). Local-folder POSTs that happen to include `kind:'local_folder'`
  // still flow through the local-folder branch below.
  if (body && typeof body === "object" && "kind" in (body as Record<string, unknown>)
      && (body as { kind?: string }).kind !== "local_folder") {
    const parsed = remoteDocumentSourceSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(parsed.error.issues[0]?.message ?? "invalid input", 400);
    }
    const { kind } = parsed.data;
    let config = parsed.data.config;
    if (kind === "gmail_mail" || kind === "outlook_mail" || kind === "icloud_mail") {
      const mail = mailSourceConfigSchema.safeParse(config);
      if (!mail.success) {
        return errorResponse(mail.error.issues[0]?.message ?? "invalid mail config", 400);
      }
      if (kind === "icloud_mail" && !mail.data.scope) {
        return errorResponse("Choose a mailbox scope for iCloud.", 400);
      }
      config = mail.data;
    }
    const synth = config.scope && (kind === "gmail_mail" || kind === "outlook_mail" || kind === "icloud_mail")
      ? `${kind.replace("_", "-")}://${createHash("sha256").update(JSON.stringify(config)).digest("hex")}`
      : syntheticPath(kind, config);
    input = {
      path: synth,
      label: parsed.data.label,
      kind: parsed.data.kind,
      config,
    };
    conflictMessage = "source already exists for this config";
  } else {
    const parsed = localDocumentSourceSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(parsed.error.issues[0]?.message ?? "invalid input", 400);
    }
    const abs = path.resolve(parsed.data.path);
    try {
      const st = await fs.stat(abs);
      if (!st.isDirectory()) {
        return errorResponse("path is not a directory", 400);
      }
    } catch {
      return errorResponse("path does not exist or is unreadable", 400);
    }
    input = { path: abs, label: parsed.data.label ?? null };
    conflictMessage = "source already exists for this path";
  }

  if (getDocumentSourceByPath(input.path)) {
    return errorResponse(conflictMessage, 409);
  }

  const row = createDocumentSource(input);
  await notifyTriggerHandlers("source_changed");
  return NextResponse.json(documentSourceToResponse(row, getDocumentSourceStats(row.id)), { status: 201 });
}
