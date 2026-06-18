import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { AgentConfig, Credential, Harness, IntegrationStatus } from "@/api/types";

export interface ExternalAgentData {
  harnesses: Harness[];
  defaultHarnessId: string;
  integrations: IntegrationStatus[];
  // Every integration credential the user has stored. The agent editor
  // needs the full list (not just the default per provider) so the
  // per-tool credential picker can offer non-default rows.
  integrationCredentials: Credential[];
  otherAgents: AgentConfig[];
}

export function useAgentExternalData(agentId: string | undefined): ExternalAgentData {
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [defaultHarnessId, setDefaultHarnessId] = useState<string>("builtin:default");
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [integrationCredentials, setIntegrationCredentials] = useState<Credential[]>([]);
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
    api.credentials.list({ type: "integration" })
      .then((rows) => { if (!cancelled) setIntegrationCredentials(rows); })
      .catch(() => { if (!cancelled) setIntegrationCredentials([]); });
    const onChange = () => {
      api.credentials.list({ type: "integration" })
        .then((rows) => { if (!cancelled) setIntegrationCredentials(rows); })
        .catch(() => { /* keep last good list */ });
    };
    if (typeof window !== "undefined") {
      window.addEventListener("jarela:credentials-changed", onChange);
    }
    return () => {
      cancelled = true;
      if (typeof window !== "undefined") {
        window.removeEventListener("jarela:credentials-changed", onChange);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.agents.list()
      .then((list) => { if (!cancelled) setOtherAgents(list.filter((a) => a.id !== agentId)); })
      .catch(() => { /* delegate picker stays empty if fetch fails */ });
    return () => { cancelled = true; };
  }, [agentId]);

  return { harnesses, defaultHarnessId, integrations, integrationCredentials, otherAgents };
}
