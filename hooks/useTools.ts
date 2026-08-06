"use client";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { ToolInfo } from "@/api/types";

export function useTools() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let seq = 0;
    const load = (force?: boolean) => {
      const mySeq = ++seq;
      api.tools
        .list(force ? { force: true } : undefined)
        .then((t) => { if (!cancelled && mySeq === seq) { setTools(t); setLoading(false); } })
        .catch((err: unknown) => { if (!cancelled && mySeq === seq) { setError(String(err)); setLoading(false); } });
    };
    load();
    // Re-fetch when a new MCP server connects, an external tool file is added,
    // or any other event that changes the available tool set. Force-bypass the
    // client cache so we always get the post-mutation state.
    const onChanged = () => load(true);
    window.addEventListener("jarela:tools-changed", onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("jarela:tools-changed", onChanged);
    };
  }, []);

  return { tools, loading, error };
}
