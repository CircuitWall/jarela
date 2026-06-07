import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { UnlockScreen } from "@/components/setup/UnlockScreen";
import { listModelConfigs } from "@/lib/stores/model-config";
import { getDb } from "@/lib/db";
import { isMasterKeyLocked } from "@/lib/crypto/master-key";

export default function Home() {
  // Touch the DB so the master-key bootstrap runs (ADR-0005). If the
  // user enabled the PIN (ADR-0063), the master key is locked here and
  // any decrypt would throw — render the unlock splash instead.
  getDb();
  if (isMasterKeyLocked()) {
    return <UnlockScreen />;
  }
  // ADR-0010: the only mandatory pre-agent screen. If no LLM provider is
  // configured, we have no agent to onboard with — punt to /setup. Once a
  // model exists, the agent can drive every other integration.
  if (listModelConfigs().length === 0) redirect("/setup");
  return <AppShell />;
}
