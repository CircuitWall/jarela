/**
 * Native Microsoft To Do tools — thin Jarela wrapper around
 * `@circuitwall/ms-todo-langchain`.
 *
 * The standalone package can do its own OAuth refresh-token dance, but
 * Jarela already runs that dance once per process in
 * `lib/integrations/microsoft-oauth.ts` (shared by outlook + outlook
 * calendar). We bypass the package's internal refresh by giving it a
 * resolver that returns a fresh access token from the shared cache, so
 * the two surfaces don't fight each other for the token quota.
 *
 * Auth uses the same Outlook integration row + env vars as Outlook Mail
 * and Calendar — see lib/integrations/microsoft-oauth.ts for the
 * resolution order. The `Tasks.ReadWrite` scope was added to
 * `MICROSOFT_SCOPES` alongside Mail/Calendar; existing connections must
 * reconnect once to pick it up.
 */
import {
  msTodoReadTools,
  msTodoWriteTools,
  setAuthResolver,
} from "@circuitwall/ms-todo-langchain";
import { registerLangChainPackage } from "./langchain-package";
import {
  getMicrosoftAccessToken,
  resolveMicrosoftAuth,
  type MicrosoftAuth,
} from "@/lib/integrations/microsoft-oauth";

// Exposed for the integrations test endpoint, matching the gmail/outlook
// `_resolveXxxAuth` probe convention.
export function _resolveMsTodoAuth(): MicrosoftAuth | { error: string } {
  return resolveMicrosoftAuth();
}

// Bridge: the package calls this on every tool invocation. We resolve
// the user's Microsoft credentials from Jarela's encrypted store (or env
// vars) and exchange them for a short-lived access token via the shared
// cache in microsoft-oauth.ts.
setAuthResolver(async () => {
  const auth = resolveMicrosoftAuth();
  if ("error" in auth) return { error: auth.error };
  const token = await getMicrosoftAccessToken(auth);
  if (typeof token !== "string") return token;
  return { access_token: token };
});

registerLangChainPackage({
  category: "Tasks",
  integrationId: "outlook",
  tools: {
    read: msTodoReadTools,
    write: msTodoWriteTools,
  },
});
