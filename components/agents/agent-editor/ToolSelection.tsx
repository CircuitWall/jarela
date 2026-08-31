import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, KeyRound, Lock } from "lucide-react";
import type { ToolInfo } from "@/api/types";
import { ProviderLogo } from "@/components/models/ProviderLogo";
import { groupByProvider, OTHER_PROVIDER_KEY } from "@/components/tools/provider-grouping";
import { permissionKindForTool, toolScoreClass } from "./permissions";

interface ToolGroupBlockProps {
  group: string;
  categories: Array<[string, ToolInfo[]]>;
  selected: string[];
  onToggleTool: (name: string) => void;
  onToggleCategory: (category: string, enable: boolean) => void;
  onToggleGroup: (group: string, enable: boolean) => void;
}

// Collapsible parent group wrapping multiple ToolCategoryBlocks. Used today
// for the "Work" header that gathers vendor-native tool categories (Atlassian,
// GitHub) under one collapsible. Header tri-state flips every tool in every
// child category on/off; the per-category blocks remain individually toggleable.
export function ToolGroupBlock({
  group, categories, selected,
  onToggleTool, onToggleCategory, onToggleGroup,
}: ToolGroupBlockProps) {
  const allTools = categories.flatMap(([, ts]) => ts);
  const selectableTools = allTools.filter(isSelectableTool);
  const selectedInGroup = selectableTools.filter((t) => selected.includes(t.name)).length;
  const allOn = selectedInGroup === selectableTools.length && selectableTools.length > 0;
  const someOn = selectedInGroup > 0 && !allOn;
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (headerRef.current) headerRef.current.indeterminate = someOn;
  }, [someOn]);

  return (
    <ToolSelectionSection
      label={group}
      open={open}
      setOpen={setOpen}
      selectedCount={selectedInGroup}
      totalCount={selectableTools.length}
      allOn={allOn}
      onToggleAll={(enable) => onToggleGroup(group, enable)}
      headerRef={headerRef}
      bodyClassName="space-y-1.5 px-2 pb-2 pt-0.5 border-t border-border/60"
    >
      {categories.map(([category, catTools]) => (
        <ToolCategoryBlock
          key={category}
          category={category}
          tools={catTools}
          selected={selected}
          onToggleTool={onToggleTool}
          onToggleCategory={onToggleCategory}
        />
      ))}
    </ToolSelectionSection>
  );
}

interface ToolCategoryBlockProps {
  category: string;
  tools: ToolInfo[];
  selected: string[];
  onToggleTool: (name: string) => void;
  onToggleCategory: (category: string, enable: boolean) => void;
}

// Collapsible per-category block with a tri-state header checkbox. The
// header toggle flips the entire category on/off; individual tool checkboxes
// stay available for fine-grained control.
export function ToolCategoryBlock({
  category, tools, selected,
  onToggleTool,
}: ToolCategoryBlockProps) {
  const selectableTools = tools.filter(isSelectableTool);
  const selectedInCat = selectableTools.filter((t) => selected.includes(t.name)).length;
  const allOn = selectedInCat === selectableTools.length && selectableTools.length > 0;
  const someOn = selectedInCat > 0 && !allOn;
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (headerRef.current) headerRef.current.indeterminate = someOn;
  }, [someOn]);

  const toggleAll = (enable: boolean) => {
    for (const t of selectableTools) {
      const isOn = selected.includes(t.name);
      if (enable !== isOn) onToggleTool(t.name);
    }
  };

  return (
    <ToolSelectionSection
      label={category}
      open={open}
      setOpen={setOpen}
      selectedCount={selectedInCat}
      totalCount={selectableTools.length}
      allOn={allOn}
      onToggleAll={toggleAll}
      headerRef={headerRef}
      bodyClassName="space-y-1.5 px-3 pb-2 pt-0.5 border-t border-border/60"
    >
      <ProviderGroupedToolGrid tools={tools} selected={selected} onToggleTool={onToggleTool} />
    </ToolSelectionSection>
  );
}

function ToolCheckbox({ tool, selected, onToggle }: { tool: ToolInfo; selected: string[]; onToggle: (name: string) => void }) {
  const isOn = selected.includes(tool.name);
  const creds = tool.credentials_required;
  const needsCreds = creds && creds.length > 0;
  const permission = tool.capability ?? permissionKindForTool(tool.name, tool.category);
  const unavailable = tool.status === "disabled" || tool.status === "unavailable";
  const title = unavailable
    ? `${tool.description}\nUnavailable: ${tool.status_reason ?? "disabled"}`
    : tool.description;
  return (
    <label
      className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors ${
        unavailable
          ? "cursor-not-allowed border-border bg-surface-2/40 opacity-70"
          : isOn ? "cursor-pointer border-accent/40 bg-accent/10" : "cursor-pointer border-border bg-surface-2/80 hover:bg-surface-3/70"
      }`}
      title={title}
    >
      <input
        type="checkbox"
        className="rounded border-border"
        checked={isOn && !unavailable}
        disabled={unavailable}
        onChange={() => onToggle(tool.name)}
      />
      <span className="min-w-0 flex-1 flex items-center gap-1.5">
        <span className="font-mono text-[11px] text-fg-muted truncate">{tool.name}</span>
        {unavailable && (
          <span className="shrink-0 text-fg-faint" title={tool.status_reason ?? "Unavailable"}>
            <Lock size={10} />
          </span>
        )}
        {needsCreds && (
          <span
            className="shrink-0 text-amber-500/80"
            title={`Requires credentials: ${creds!.join(", ")}`}
          >
            <KeyRound size={10} />
          </span>
        )}
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] border ${toolScoreClass(tool.stats?.score ?? 1)}`}>
          {Math.round((tool.stats?.score ?? 1) * 100)}%
        </span>
        <span className="shrink-0 rounded border border-border bg-surface-3 px-1.5 py-0.5 text-[10px] text-fg-muted capitalize">
          {permission}
        </span>
      </span>
    </label>
  );
}

// Renders the advanced-mode grid of per-tool checkboxes, but with tools
// clustered into per-provider sub-boxes (Gmail / Outlook / iCloud / Other).
// Wide categories like "Mail" span multiple vendors — the boxes let the
// user pick "all of Outlook" without also flipping Gmail on. Provider
// header carries a tri-state checkbox that toggles every tool inside.
function ProviderGroupedToolGrid({
  tools,
  selected,
  onToggleTool,
}: {
  tools: ToolInfo[];
  selected: string[];
  onToggleTool: (name: string) => void;
}) {
  const groups = groupByProvider(tools, (t) => t.name);
  // Single provider (typically "Other" for e.g. Memory / Files / Shell):
  // skip the extra box chrome and render a flat grid like before.
  if (groups.length === 1) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {tools.map((t) => (
          <ToolCheckbox key={t.name} tool={t} selected={selected} onToggle={onToggleTool} />
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {groups.map((g) => (
        <ProviderToolBox
          key={g.provider}
          provider={g.provider}
          label={g.label}
          tools={g.items}
          selected={selected}
          onToggleTool={onToggleTool}
        />
      ))}
    </div>
  );
}

function ProviderToolBox({
  provider,
  label,
  tools,
  selected,
  onToggleTool,
}: {
  provider: string;
  label: string;
  tools: ToolInfo[];
  selected: string[];
  onToggleTool: (name: string) => void;
}) {
  const selectable = tools.filter(isSelectableTool);
  const selectedInProv = selectable.filter((t) => selected.includes(t.name)).length;
  const allOn = selectedInProv === selectable.length && selectable.length > 0;
  const someOn = selectedInProv > 0 && !allOn;
  const headerRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerRef.current) headerRef.current.indeterminate = someOn;
  }, [someOn]);
  const toggleAll = (enable: boolean) => {
    for (const t of selectable) {
      const isOn = selected.includes(t.name);
      if (enable !== isOn) onToggleTool(t.name);
    }
  };
  return (
    <div className="rounded-lg border border-border/70 bg-surface-2/50">
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-border/50">
        <input
          ref={headerRef}
          type="checkbox"
          className="rounded border-border"
          checked={allOn}
          onChange={(e) => toggleAll(e.target.checked)}
          aria-label={`Toggle all ${label} tools`}
        />
        {provider !== OTHER_PROVIDER_KEY && (
          <ProviderLogo name={provider} size={12} className="text-fg-subtle" />
        )}
        <span className="text-[11px] font-semibold text-fg-muted">{label}</span>
        <span className="text-[10px] text-fg-faint ml-auto">
          {selectedInProv}/{tools.length}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 p-2">
        {tools.map((t) => (
          <ToolCheckbox key={t.name} tool={t} selected={selected} onToggle={onToggleTool} />
        ))}
      </div>
    </div>
  );
}

function isSelectableTool(tool: ToolInfo): boolean {
  return tool.status !== "disabled" && tool.status !== "unavailable";
}

interface ToolSelectionSectionProps {
  label: string;
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  selectedCount: number;
  totalCount: number;
  allOn: boolean;
  onToggleAll: (enable: boolean) => void;
  headerRef: React.RefObject<HTMLInputElement | null>;
  bodyClassName: string;
  children: React.ReactNode;
}

function ToolSelectionSection({
  label, open, setOpen, selectedCount, totalCount, allOn,
  onToggleAll, headerRef, bodyClassName, children,
}: ToolSelectionSectionProps) {
  return (
    <div className="rounded-xl border border-border bg-surface-1/40 overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-2 bg-surface-2/50">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-fg-subtle hover:text-fg transition-colors"
          aria-label={open ? "Collapse" : "Expand"}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <label className="flex items-center gap-1.5 cursor-pointer flex-1 min-w-0">
          <input
            ref={headerRef}
            type="checkbox"
            className="rounded border-border"
            checked={allOn}
            onChange={(e) => onToggleAll(e.target.checked)}
          />
          <span className="text-[12px] font-semibold text-fg truncate">{label}</span>
        </label>
        <span className="text-[10px] text-fg-faint shrink-0">{selectedCount}/{totalCount}</span>
      </div>
      {open && <div className={bodyClassName}>{children}</div>}
    </div>
  );
}
