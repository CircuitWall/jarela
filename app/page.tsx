import { AppShell } from "@/components/layout/AppShell";
import { UnlockScreen } from "@/components/setup/UnlockScreen";
import { FirstKeySetup } from "@/components/setup/FirstKeySetup";
import { listEnabledModelConfigs } from "@/lib/stores/model-config";
import { listAgentConfigs } from "@/lib/stores/agent-configs";
import { getDb } from "@/lib/db";
import { isMasterKeyLocked } from "@/lib/crypto/master-key";

// Re-evaluate on every request: the master-key lock state changes at
// runtime (PIN unlock) and is not an explicit dynamic dependency Next can
// see, so without this the page would be statically prerendered at build
// time (when the key is locked) and served forever from the route cache.
export const dynamic = "force-dynamic";

export default function Home() {
  // Touch the DB so the master-key bootstrap runs (ADR-0005). If the
  // user enabled the PIN (ADR-0063), the master key is locked here and
  // any decrypt would throw — render the unlock splash instead.
  getDb();
  if (isMasterKeyLocked()) {
    return <UnlockScreen />;
  }
  // Keep fresh and incomplete installations in the guided setup until both
  // a usable model and an assistant exist.
  if (listEnabledModelConfigs().length === 0 || listAgentConfigs().length === 0) {
    return <FirstKeySetup />;
  }
  return <AppShell />;
}
