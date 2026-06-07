// First-key setup screen (ADR-0010). The single static wall before the agent
// can take over onboarding. If a model_config already exists, redirect to the
// app — there's nothing to set up.

import { redirect } from "next/navigation";
import { listModelConfigs } from "@/lib/stores/model-config";
import { FirstKeySetup } from "@/components/setup/FirstKeySetup";
import { UnlockScreen } from "@/components/setup/UnlockScreen";
import { getDb } from "@/lib/db";
import { isMasterKeyLocked } from "@/lib/crypto/master-key";

export default function SetupPage() {
  getDb();
  if (isMasterKeyLocked()) {
    return <UnlockScreen />;
  }
  const configs = listModelConfigs();
  if (configs.length > 0) redirect("/");
  return <FirstKeySetup />;
}
