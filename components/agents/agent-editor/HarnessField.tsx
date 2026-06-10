import { Select } from "@/components/ui/Select";
import type { Harness } from "@/api/types";
import type { AgentEditorForm } from "./useAgentEditorForm";

export function HarnessField({ form }: { form: AgentEditorForm }) {
  return (
    <>
      <label className="block">
        <span className="text-xs text-fg-subtle mb-1 block">Harness</span>
        <Select value={form.harnessId} onChange={(e) => form.setHarnessId(e.target.value)}>
          <option value="">
            Use global default{defaultHarnessLabel(form.harnesses, form.defaultHarnessId)}
          </option>
          {form.harnesses.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}{h.builtin ? " (built-in)" : ""}
            </option>
          ))}
        </Select>
      </label>
      <p className="text-[11px] text-fg-faint">
        Behavioral scaffolding (output formatting, citation rules, anti-fabrication, self-config) injected into this agent&apos;s system prompt.
      </p>
    </>
  );
}

function defaultHarnessLabel(harnesses: Harness[], defaultHarnessId: string): string {
  const def = harnesses.find((h) => h.id === defaultHarnessId);
  return def ? ` (${def.name})` : "";
}
