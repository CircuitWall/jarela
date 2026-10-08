import { useState } from "react";
import { errorMessage } from "@/lib/utils/error";
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
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return { saving, error, handleSave };
}
