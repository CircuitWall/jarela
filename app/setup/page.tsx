// Guided setup entry. A workspace is considered ready only after it has an
// enabled model and at least one agent; otherwise the wizard can complete it.

import { redirect } from "next/navigation";
import { listEnabledModelConfigs } from "@/lib/stores/model-config";
import { listAgentConfigs } from "@/lib/stores/agent-configs";
import { FirstKeySetup } from "@/components/setup/FirstKeySetup";
import { UnlockScreen } from "@/components/setup/UnlockScreen";
import { getDb } from "@/lib/db";
import { isMasterKeyLocked } from "@/lib/crypto/master-key";

// Same reason as app/page.tsx — master-key lock state changes at runtime
// and Next can't see it as a dynamic dependency.
export const dynamic = "force-dynamic";

export default function SetupPage() {
  getDb();
  if (isMasterKeyLocked()) {
    return <UnlockScreen />;
  }
  const hasUsableWorkspace = listEnabledModelConfigs().length > 0 && listAgentConfigs().length > 0;
  if (hasUsableWorkspace) redirect("/");
  return <FirstKeySetup />;
}
