import { useState, useMemo } from "react";
import { Search, X } from "lucide-react";
import type { AgentEditorForm } from "./useAgentEditorForm";
import { Section } from "./Section";
import { ToolCategoryBlock, ToolGroupBlock } from "./ToolSelection";

export function ToolsSection({ form, advancedMode }: { form: AgentEditorForm; advancedMode: boolean }) {
  void advancedMode;
  return (
    <Section step={3} title="Tools">
      {form.tools.length === 0
        ? <p className="text-xs text-fg-faint">No tools available.</p>
        : <ToolsBody form={form} advancedMode={advancedMode} />}
    </Section>
  );
}

function ToolsBody({ form, advancedMode }: { form: AgentEditorForm; advancedMode: boolean }) {
  const [filterText, setFilterText] = useState("");

  // Filter tools and their groups/categories based on search text
  const filteredGroupedTools = useMemo(() => {
    if (!filterText.trim()) return form.groupedTools;

    const query = filterText.toLowerCase();
    return form.groupedTools
      .map(({ group, categories }) => ({
        group,
        categories: categories
          .map(
            ([category, catTools]) =>
              [
                category,
                catTools.filter(
                  (t) =>
                    t.name.toLowerCase().includes(query) ||
                    t.description?.toLowerCase().includes(query) ||
                    t.category?.toLowerCase().includes(query),
                ),
              ] as [string, typeof catTools],
          )
          .filter(([, tools]) => tools.length > 0),
      }))
      .filter(({ categories }) => categories.length > 0);
  }, [filterText, form.groupedTools]);

  const matchCount = useMemo(
    () =>
      filteredGroupedTools.reduce(
        (sum, { categories }) => sum + categories.reduce((s, [, tools]) => s + tools.length, 0),
        0,
      ),
    [filteredGroupedTools],
  );

  return (
    <>
      <ToolsHeader form={form} />
      <div className="mb-2">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-2.5 text-fg-muted pointer-events-none" />
          <input
            type="text"
            placeholder="Search tools..."
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            className="w-full pl-8 pr-8 py-1.5 text-xs rounded border border-border bg-surface-3 text-fg placeholder-fg-muted focus:outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/40"
          />
          {filterText && (
            <button
              onClick={() => setFilterText("")}
              className="absolute right-2.5 top-2.5 p-0.5 hover:text-fg transition-colors"
              title="Clear search"
            >
              <X size={12} />
            </button>
          )}
        </div>
        {filterText && (
          <p className="text-[10px] text-fg-faint mt-1">
            {matchCount} of {form.tools.length} tool{matchCount !== 1 ? "s" : ""} matching
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        {filteredGroupedTools.map(({ group, categories }) =>
          group
            ? <ToolGroupBlock
                key={group}
                group={group}
                categories={categories}
                selected={form.selectedTools}
                onToggleTool={form.toggleTool}
                onToggleCategory={form.toggleCategory}
                onToggleGroup={form.toggleGroup}
              />
            : categories.map(([category, catTools]) => (
                <ToolCategoryBlock
                  key={category}
                  category={category}
                  tools={catTools}
                  selected={form.selectedTools}
                  onToggleTool={form.toggleTool}
                  onToggleCategory={form.toggleCategory}
                />
              )),
        )}
        {filteredGroupedTools.length === 0 && filterText && (
          <p className="text-xs text-fg-faint py-2 text-center">
            No tools matching &quot;<span className="font-mono">{filterText}</span>&quot;
          </p>
        )}
      </div>
    </>
  );
}

function ToolsHeader({ form }: { form: AgentEditorForm }) {
  const selectableTools = form.tools.filter((tool) => tool.status !== "disabled" && tool.status !== "unavailable");
  const selectedSelectable = selectableTools.filter((tool) => form.selectedTools.includes(tool.name)).length;
  const allOn = selectedSelectable === selectableTools.length && selectableTools.length > 0;
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-fg-faint">{selectedSelectable} of {selectableTools.length} enabled</span>
      <button onClick={form.toggleAllTools} className="text-[11px] text-fg-faint hover:text-fg-muted transition-colors">
        {allOn ? "Deselect all" : "Select all"}
      </button>
    </div>
  );
}
