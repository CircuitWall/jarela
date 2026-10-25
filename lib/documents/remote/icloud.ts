import { createHash } from "node:crypto";
import type { scanICloudMail } from "@circuitwall/icloud-langchain";
import { getIntegrationRaw } from "@/lib/stores/integrations";
import { parseSourceConfig, type DocumentSourceRow } from "@/lib/stores/document-sources";
import { optionalFunction } from "@/lib/tools/packages/optional-package";
import { parseMailSourceConfig } from "@/lib/documents/mail-source-config";
import { stripHtml } from "@/lib/utils/html";
import { upsertRemoteDocument, evictMissing } from "./upsert";
import type { RemoteIndexStats } from "./index";

const scanMail = optionalFunction<typeof scanICloudMail>(
  "@circuitwall/icloud-langchain",
  "scanICloudMail",
  async () => { throw new Error("iCloud indexing requires an updated @circuitwall/icloud-langchain package. Install or update it in Packages."); },
);

export async function indexICloudMail(source: DocumentSourceRow): Promise<RemoteIndexStats> {
  const config = parseMailSourceConfig(parseSourceConfig(source));
  if (!config.scope) throw new Error("Choose a mailbox scope for iCloud indexing.");
  const envId = process.env.ICLOUD_APPLE_ID?.trim();
  const envPassword = process.env.ICLOUD_APP_PASSWORD?.trim();
  const saved = envId && envPassword ? null : getIntegrationRaw("icloud");
  const appleId = envId && envPassword ? envId : saved?.apple_id;
  const appPassword = envId && envPassword ? envPassword : saved?.app_password;
  if (!appleId || !appPassword) {
    throw new Error("iCloud not configured. Add your Apple ID and app-specific password in Credentials → iCloud.");
  }
  const stats: RemoteIndexStats = { scanned: 0, added: 0, updated: 0, unchanged: 0, errors: 0 };
  const keep = new Set<string>();
  await scanMail({ appleId, appPassword }, {
    scope: config.scope,
    folder: config.folder,
    query: config.query,
    maxResults: Number.isFinite(config.max_results) ? config.max_results : undefined,
  }, async (message) => {
    const path = `icloud://${createHash("sha256").update(message.id).digest("hex")}`;
    const text = [
      `From: ${message.from}`, `To: ${message.to}`, `Subject: ${message.subject}`,
      `Date: ${message.date ?? ""}`, "",
      message.html ? stripHtml(message.text, { preserveParagraphs: true }) : message.text,
    ].join("\n");
    const item = await upsertRemoteDocument(source.id, {
      path, title: message.subject, text, externalUpdatedAt: message.date ?? "",
    });
    keep.add(path);
    stats.scanned++;
    stats.added += item.status === "added" ? 1 : 0;
    stats.updated += item.status === "updated" ? 1 : 0;
    stats.unchanged += item.status === "unchanged" ? 1 : 0;
    stats.errors += item.embedError ? 1 : 0;
    stats.embedFailed = (stats.embedFailed ?? 0) + Math.max(item.chunks - item.embedded, 0);
    if (item.embedError && !stats.embedError) stats.embedError = item.embedError;
  });
  stats.removed = config.retention === "mirror" ? evictMissing(source.id, keep) : 0;
  return stats;
}
