import type { ModelConfig } from "@/api/types";
import { TierProportionBar } from "../TierProportionBar";
import type { AgentEditorForm } from "./useAgentEditorForm";

interface Props {
  form: AgentEditorForm;
  selectedModel: ModelConfig | undefined;
}

// ADR-0043. Per-agent override of the hot / warm / facts split.
// Bar shows the effective value (override or model fallback);
// "Inherit from model" link clears the override.
export function TierOverrideField({ form, selectedModel }: Props) {
  const fallback = {
    hot: selectedModel?.params?.context_tier_proportions?.hot ?? 60,
    warm: selectedModel?.params?.context_tier_proportions?.warm ?? 25,
    facts: selectedModel?.params?.context_tier_proportions?.facts ?? 15,
  };
  const value = form.tierOverride ?? fallback;
  const isOverriding = form.tierOverride !== null;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-fg-subtle">Context tier split</span>
        {isOverriding ? (
          <button
            type="button"
            onClick={() => form.setTierOverride(null)}
            className="text-[11px] text-fg-faint hover:text-accent transition-colors"
          >
            Inherit from model
          </button>
        ) : (
          <span className="text-[11px] text-fg-faint italic">
            {selectedModel ? `inheriting from ${selectedModel.name}` : "using built-in defaults"}
          </span>
        )}
      </div>
      <TierProportionBar value={value} onChange={(next) => form.setTierOverride(next)} />
    </div>
  );
}
