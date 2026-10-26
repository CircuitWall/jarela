"use client";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { AgentConfig, UserProfile } from "@/api/types";

interface Result {
  userProfile: UserProfile | null;
  profileLoading: boolean;
  agentConfig: AgentConfig | null;
  agentConfigLoading: boolean;
}

export function useUserProfileAndAgent(agentId: string | null): Result {
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [agentConfigLoading, setAgentConfigLoading] = useState(false);

  useEffect(() => {
    setProfileLoading(true);
    let cancelled = false;
    api.profile.get({ startup: true })
      .then((profile) => { if (!cancelled) setUserProfile(profile); })
      .catch((error) => { if (!cancelled) console.error(error); })
      .finally(() => { if (!cancelled) setProfileLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!agentId) {
      setAgentConfig(null);
      setAgentConfigLoading(false);
      return;
    }
    const id = agentId;
    let cancelled = false;
    let requestSeq = 0;
    setAgentConfig(null);
    setAgentConfigLoading(true);
    function refresh(startup = false) {
      const seq = ++requestSeq;
      api.agents.get(id, startup ? { startup: true } : undefined)
        .then((config) => { if (!cancelled && seq === requestSeq) setAgentConfig(config); })
        .catch((error) => { if (!cancelled && seq === requestSeq) console.error(error); })
        .finally(() => { if (!cancelled && seq === requestSeq) setAgentConfigLoading(false); });
    }
    const onChanged = () => refresh();
    refresh(true);
    window.addEventListener("jarela:agents-changed", onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("jarela:agents-changed", onChanged);
    };
  }, [agentId]);

  return { userProfile, profileLoading, agentConfig, agentConfigLoading };
}
