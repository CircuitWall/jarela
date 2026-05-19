// First-key setup screen (ADR-0010). The single static wall before the agent
// can take over onboarding. If a model_config already exists, redirect to the
// app — there's nothing to set up.

import { redirect } from "next/navigation";
import { listModelConfigs } from "@/lib/stores/model-config";
import { FirstKeySetup } from "@/components/setup/FirstKeySetup";

export default function SetupPage() {
  const configs = listModelConfigs();
  if (configs.length > 0) redirect("/");
  return <FirstKeySetup />;
}
