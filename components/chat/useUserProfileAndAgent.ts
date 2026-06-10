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
    api.profile.get().then(setUserProfile).catch(console.error).finally(() => setProfileLoading(false));
  }, []);

  useEffect(() => {
    if (!agentId) {
      setAgentConfig(null);
      setAgentConfigLoading(false);
      return;
    }
    setAgentConfigLoading(true);
    api.agents.get(agentId).then(setAgentConfig).catch(console.error).finally(() => setAgentConfigLoading(false));
  }, [agentId]);

  return { userProfile, profileLoading, agentConfig, agentConfigLoading };
}
