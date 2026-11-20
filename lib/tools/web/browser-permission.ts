/**
 * Ask-once host access for the browser tools.
 *
 * The extension only holds static host permissions for the Jarela server;
 * every other origin needs the user to grant it (`chrome.permissions.request`
 * needs a gesture, so the agent cannot do it itself). Without this tool the
 * agent saw a generic failure, retried, and eventually stopped with a retry
 * notice — it never asked.
 *
 * The decision is stored in `allowed_sites`, which the Settings → Allowed
 * sites panel already lists and revokes, and which the extension caches for
 * cookie passthrough. One place to manage the answer.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { isHostAllowed } from "@/lib/stores/allowed-sites";
import { registerLangChainPackage } from "../packages/langchain-package";

function hostnameOf(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return parsed.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export const browserPermissionTool = tool(
  async ({ url }) => {
    const hostname = hostnameOf(url);
    if (!hostname) {
      return JSON.stringify({ allowed: false, error: "provide a URL or hostname, e.g. https://example.com/path" });
    }

    const match = isHostAllowed(hostname);
    if (match.allowed) {
      return JSON.stringify({
        allowed: true,
        hostname: match.matchedHostname,
        rule: match.matchedHostname === hostname ? "exact" : "suffix",
      });
    }

    return JSON.stringify({
      allowed: false,
      hostname,
      ask_user: true,
      propose_kind: "allow_site",
      instruction:
        `Jarela is not allowed to act on ${hostname} yet. Ask the user once with ` +
        `propose_config_change({ kind: "allow_site", payload: { hostname: "${hostname}" }, reason: "..." }) ` +
        "and say in the reason that approving lets the agent drive a tab on this host and share its cookies with web_fetch. " +
        "The answer is saved in Settings → Allowed sites, where it can be reviewed or revoked. " +
        "Do not retry the browser step for this host until the user answers.",
    });
  },
  {
    name: "browser_permission",
    description:
      "Check whether Jarela may act on a browser host, and get the exact ask-user instruction when it may not. " +
      "Call this before driving a site the agent has not used in this conversation, and whenever a browser step " +
      "returns host_permission_required. Read-only: it never grants anything itself — the user approves via the " +
      "allow_site proposal, and the answer is stored in the Allowed sites list.",
    schema: z.object({
      url: z.string().min(1).describe("URL or hostname the agent needs, e.g. 'https://example.com/inbox' or 'example.com'"),
    }),
  },
);

registerLangChainPackage({ category: "Web", tools: { read: [browserPermissionTool] } });
