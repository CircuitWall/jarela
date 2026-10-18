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
    let cancelled = false;
    setAgentConfig(null);
    setAgentConfigLoading(true);
    api.agents.get(agentId, { startup: true })
      .then((config) => { if (!cancelled) setAgentConfig(config); })
      .catch((error) => { if (!cancelled) console.error(error); })
      .finally(() => { if (!cancelled) setAgentConfigLoading(false); });
    return () => { cancelled = true; };
  }, [agentId]);

  return { userProfile, profileLoading, agentConfig, agentConfigLoading };
}
