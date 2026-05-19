import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { listModelConfigs } from "@/lib/stores/model-config";

export default function Home() {
  // ADR-0010: the only mandatory pre-agent screen. If no LLM provider is
  // configured, we have no agent to onboard with — punt to /setup. Once a
  // model exists, the agent can drive every other integration.
  if (listModelConfigs().length === 0) redirect("/setup");
  return <AppShell />;
}
