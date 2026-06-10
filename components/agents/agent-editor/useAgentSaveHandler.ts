import { useState } from "react";
import { pushErrorToast } from "@/lib/ui/error-report";
import type { AgentConfigIn } from "@/api/types";

interface Args {
  buildPayload: () => AgentConfigIn;
  getName: () => string;
  onSave: (data: AgentConfigIn) => Promise<void>;
  onClose: () => void;
}

export function useAgentSaveHandler({ buildPayload, getName, onSave, onClose }: Args) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    const trimmed = getName().trim();
    if (!trimmed) { setError("Name is required"); return; }
    setSaving(true);
    try {
      await onSave(buildPayload());
      onClose();
    } catch (e) {
      pushErrorToast({
        title: "Couldn't save agent",
        error: e,
        context: { panel: "agents", action: "agent.save", agent_name: trimmed },
      });
    } finally {
      setSaving(false);
    }
  }

  return { saving, error, handleSave };
}
