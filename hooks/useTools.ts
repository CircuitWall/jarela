"use client";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { ToolInfo } from "@/api/types";

export function useTools() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.tools
      .list()
      .then(setTools)
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  return { tools, loading, error };
}
