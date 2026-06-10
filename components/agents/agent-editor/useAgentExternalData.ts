import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { AgentConfig, Harness, IntegrationStatus } from "@/api/types";

export interface ExternalAgentData {
  harnesses: Harness[];
  defaultHarnessId: string;
  integrations: IntegrationStatus[];
  otherAgents: AgentConfig[];
}

export function useAgentExternalData(agentId: string | undefined): ExternalAgentData {
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [defaultHarnessId, setDefaultHarnessId] = useState<string>("builtin:default");
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [otherAgents, setOtherAgents] = useState<AgentConfig[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.harnesses.list()
      .then((res) => { if (!cancelled) { setHarnesses(res.harnesses); setDefaultHarnessId(res.default_harness_id); } })
      .catch(() => { /* picker stays empty if fetch fails */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.integrations.list()
      .then((res) => { if (!cancelled) setIntegrations(res.statuses); })
      .catch(() => { if (!cancelled) setIntegrations([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.agents.list()
      .then((list) => { if (!cancelled) setOtherAgents(list.filter((a) => a.id !== agentId)); })
      .catch(() => { /* delegate picker stays empty if fetch fails */ });
    return () => { cancelled = true; };
  }, [agentId]);

  return { harnesses, defaultHarnessId, integrations, otherAgents };
}
