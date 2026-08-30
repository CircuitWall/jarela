"use client";
import { api } from "@/api/client";
import type { ToolInfo } from "@/api/types";
import { useListState, type UnifiedHookResult } from "@/hooks/useListState";

export function useTools(): UnifiedHookResult<
  { tools: ToolInfo[]; loading: boolean; error: string | null },
  { refresh: () => Promise<void> }
> {
  const {
    items: tools,
    loading,
    error,
    refresh,
  } = useListState<ToolInfo>({
    loader: () => api.tools.list({ includeDisabled: true }),
    // Re-fetch when a new MCP server connects, an external tool file is added,
    // or any other event that changes the available tool set. Force-bypass the
    // client cache so we always get the post-mutation state.
    eventName: "jarela:tools-changed",
    eventLoader: () => api.tools.list({ force: true, includeDisabled: true }),
    initialLoading: true,
  });

  const state = { tools, loading, error };
  const commands = { refresh };

  return { state, commands, tools, loading, error, refresh };
}
