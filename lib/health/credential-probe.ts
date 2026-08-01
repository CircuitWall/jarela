// Guard the credential-save endpoints against persisting a dead token.
// The scheduler already probes every ~10min and the periodic sweep will
// eventually flag a broken credential, but that's too late for the
// operator sitting at the "Save" dialog — they'll hit Save, close the
// dialog, and then get a run failure on the next chat turn with no
// obvious causal link. Probing synchronously right after
// createCredential / updateCredential converts "dead credentials
// silently accepted" into "Save button shows a red banner with the
// vendor's rejection message" — same class of check as `git commit`
// running the pre-commit hook.
//
// Scope: integration-type credentials only. LLM-provider probes
// (Anthropic/OpenAI/…) read from getIntegrationRaw() rather than
// respecting a credential-id override, so probing them after save would
// test whatever value was live in the integrations store, not the new
// credential row. Adding override support to those probes is a
// separate change (ADR-0070 tracks the delta).

import { isIntegrationProbe, runProbe, type HealthResult } from "./probes";
import { runWithToolCredentialContext } from "@/lib/tools/credential-context";

// Same synthetic tool name that the /api/v1/integrations/[name]/test
// route uses — the credential-context lookup keys off this string.
const SAVE_PROBE_TOOL_NAME = "__integration_probe__";

export interface ProbeAfterSaveOptions {
  /** Credential id that was just created / updated. */
  credentialId: string;
  /** Credential provider name (matches ProbeName for integrations). */
  provider: string;
}

/**
 * Runs the integration probe for a credential that was just written.
 * Returns null when the provider has no probe registered (LLM provider
 * or unknown integration), so the caller can distinguish "probe passed"
 * from "no opinion, allow the save".
 */
export async function probeCredentialAfterSave(
  opts: ProbeAfterSaveOptions,
): Promise<HealthResult | null> {
  if (!isIntegrationProbe(opts.provider)) return null;
  return runWithToolCredentialContext(
    {
      toolName: SAVE_PROBE_TOOL_NAME,
      toolCredentials: { [SAVE_PROBE_TOOL_NAME]: opts.credentialId },
    },
    () => runProbe(opts.provider as Parameters<typeof runProbe>[0]),
  );
}
