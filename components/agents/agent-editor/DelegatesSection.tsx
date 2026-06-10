import type { AgentConfig } from "@/api/types";
import type { AgentEditorForm } from "./useAgentEditorForm";
import { Section } from "./Section";

export function DelegatesSection({ form }: { form: AgentEditorForm }) {
  // Only meaningful when delegate_to_agent is enabled.
  const canDelegate = form.selectedTools.includes("delegate_to_agent");
  if (!canDelegate && form.delegateTargets.length === 0) return null;

  return (
    <>
      <hr className="border-border" />
      <Section step={4} title="Delegates">
        <p className="text-[11px] text-fg-faint">
          Other agents this one may hand subtasks to via <code>delegate_to_agent</code>.
          {!canDelegate && (
            <span className="text-amber-700 dark:text-amber-400">
              {" "}Enable the <code>delegate_to_agent</code> tool above for these to take effect.
            </span>
          )}
        </p>
        {form.otherAgents.length === 0 ? (
          <p className="text-xs text-fg-faint">No other agents to delegate to yet.</p>
        ) : (
          <div className="space-y-1">
            {form.otherAgents.map((a) => (
              <DelegateRow
                key={a.id}
                agent={a}
                checked={form.delegateTargets.includes(a.id)}
                onToggle={() =>
                  form.setDelegateTargets((prev) =>
                    prev.includes(a.id) ? prev.filter((x) => x !== a.id) : [...prev, a.id],
                  )
                }
              />
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function DelegateRow({ agent, checked, onToggle }: { agent: AgentConfig; checked: boolean; onToggle: () => void }) {
  return (
    <label className="flex items-start gap-2 p-1.5 rounded hover:bg-surface-3/50 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={onToggle} className="mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-fg">{agent.name}</div>
        {agent.identity && (
          <div className="text-[11px] text-fg-faint truncate">
            {agent.identity.split("\n")[0]}
          </div>
        )}
      </div>
    </label>
  );
}
