import type { AgentEditorForm } from "./useAgentEditorForm";
import { Section } from "./Section";
import { ToolCategoryBlock, ToolGroupBlock } from "./ToolSelection";

export function ToolsSection({ form, advancedMode }: { form: AgentEditorForm; advancedMode: boolean }) {
  return (
    <Section step={3} title="Tools">
      {form.tools.length === 0
        ? <p className="text-xs text-fg-faint">No tools available.</p>
        : <ToolsBody form={form} advancedMode={advancedMode} />}
    </Section>
  );
}

function ToolsBody({ form, advancedMode }: { form: AgentEditorForm; advancedMode: boolean }) {
  return (
    <>
      <ToolsHeader form={form} />
      <div className="space-y-1.5">
        {form.groupedTools.map(({ group, categories }) =>
          group
            ? <ToolGroupBlock
                key={group}
                group={group}
                categories={categories}
                advancedMode={advancedMode}
                selected={form.selectedTools}
                onToggleTool={form.toggleTool}
                onToggleCategory={form.toggleCategory}
                onToggleCategoryPermission={form.toggleCategoryPermission}
                onToggleGroup={form.toggleGroup}
              />
            : categories.map(([category, catTools]) => (
                <ToolCategoryBlock
                  key={category}
                  category={category}
                  tools={catTools}
                  advancedMode={advancedMode}
                  selected={form.selectedTools}
                  onToggleTool={form.toggleTool}
                  onToggleCategory={form.toggleCategory}
                  onToggleCategoryPermission={form.toggleCategoryPermission}
                />
              )),
        )}
      </div>
    </>
  );
}

function ToolsHeader({ form }: { form: AgentEditorForm }) {
  const allOn = form.selectedTools.length === form.tools.length;
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-fg-faint">{form.selectedTools.length} of {form.tools.length} enabled</span>
      <button onClick={form.toggleAllTools} className="text-[11px] text-fg-faint hover:text-fg-muted transition-colors">
        {allOn ? "Deselect all" : "Select all"}
      </button>
    </div>
  );
}
