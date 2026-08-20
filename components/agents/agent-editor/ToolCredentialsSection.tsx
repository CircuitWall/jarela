import { useMemo } from "react";
import type { Credential } from "@/api/types";
import type { AgentEditorForm } from "./useAgentEditorForm";
import { Section } from "./Section";

// Tool-provider match result, including the matching rule for display.
interface MatchedTool {
  name: string;
  provider: string;
  matchRule: "name_prefix" | "category";
  credentialCount: number;
}

// Renders a per-tool credential picker for every enabled tool whose
// provider has credentials. Single-credential tools show as read-only
// default state with hint to add another credential; multi-credential
// tools show active dropdown to override. All matched tools are visible
// to make the tool-provider linkage explicit.
export function ToolCredentialsSection({ form }: { form: AgentEditorForm }) {
  const { selectedTools, tools, integrationCredentials } = form;

  const credsByProvider = useMemo(() => {
    const m = new Map<string, Credential[]>();
    for (const c of integrationCredentials) {
      const arr = m.get(c.provider) ?? [];
      arr.push(c);
      m.set(c.provider, arr);
    }
    return m;
  }, [integrationCredentials]);

  const allProviders = useMemo(() => [...credsByProvider.keys()], [credsByProvider]);

  // Build {toolName: provider, matchRule} for tools whose provider is known.
  // A tool belongs to provider P if its name starts with `${P}_` or its
  // category equals P (case-insensitive). Shown for ALL credential counts
  // to make linkage transparent.
  const matchedTools = useMemo(() => {
    const toolByName = new Map(tools.map((t) => [t.name, t]));
    const out: MatchedTool[] = [];
    for (const toolName of selectedTools) {
      const t = toolByName.get(toolName);
      const match = allProviders.find((p) => {
        if (toolName.toLowerCase().startsWith(`${p.toLowerCase()}_`)) return true;
        if (t?.category && t.category.toLowerCase() === p.toLowerCase()) return true;
        return false;
      });
      if (match) {
        const matchRule = toolName.toLowerCase().startsWith(`${match.toLowerCase()}_`)
          ? "name_prefix"
          : "category";
        out.push({
          name: toolName,
          provider: match,
          matchRule,
          credentialCount: credsByProvider.get(match)?.length ?? 0,
        });
      }
    }
    return out;
  }, [allProviders, selectedTools, tools, credsByProvider]);

  // Early return after all hooks are called
  if (matchedTools.length === 0 || integrationCredentials.length === 0) return null;

  const providersWithMultiple = allProviders.filter((p) => (credsByProvider.get(p) ?? []).length >= 2);

  return (
    <Section step={4} title="Tool credentials">
      <div className="space-y-3">
        <div className="text-[11px] text-fg-faint space-y-1">
          <p>
            Credentials are automatically matched to tools by integration. Tools use
            the provider&apos;s default credential unless you override below.
          </p>
          {providersWithMultiple.length > 0 && (
            <p>
              {providersWithMultiple.length === 1
                ? `${providersWithMultiple[0]} has multiple credentials. Pick one per tool below, or leave as <em>Default</em>.`
                : `${formatProviderList(providersWithMultiple)} have multiple credentials each. Pick one per tool below, or leave as <em>Default</em>.`}
            </p>
          )}
          {providersWithMultiple.length === 0 && (
            <p>
              Add another credential for any provider to switch between them per tool.
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          {matchedTools.map((mt) => (
            <ToolCredentialRow
              key={mt.name}
              tool={mt}
              options={credsByProvider.get(mt.provider) ?? []}
              selectedId={form.toolCredentials[mt.name] ?? ""}
              onChange={(id) => form.setToolCredentialFor(mt.name, id || null)}
            />
          ))}
        </div>
      </div>
    </Section>
  );
}

function formatProviderList(providers: string[]): string {
  if (providers.length === 1) return providers[0];
  if (providers.length === 2) return `${providers[0]} and ${providers[1]}`;
  return `${providers.slice(0, -1).join(", ")}, and ${providers[providers.length - 1]}`;
}

function matchRuleLabel(rule: "name_prefix" | "category"): string {
  return rule === "name_prefix" ? "name prefix" : "category";
}

function ToolCredentialRow({
  tool,
  options,
  selectedId,
  onChange,
}: {
  tool: MatchedTool;
  options: Credential[];
  selectedId: string;
  onChange: (id: string) => void;
}) {
  const isMultiCredential = tool.credentialCount >= 2;
  const defaultCred = options.find((c) => c.is_default);
  const defaultLabel = defaultCred ? (defaultCred.label ?? defaultCred.id) : "default";

  return (
    <div className="flex items-center gap-2 text-xs">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-fg-muted truncate">{tool.name}</span>
          {!isMultiCredential && (
            <span className="text-[10px] text-fg-faint whitespace-nowrap">({tool.provider})</span>
          )}
        </div>
        <div className="text-[10px] text-fg-faint">
          Matched by {matchRuleLabel(tool.matchRule)}
        </div>
      </div>
      {isMultiCredential ? (
        <select
          value={selectedId}
          onChange={(e) => onChange(e.target.value)}
          className="px-2 py-1 text-xs rounded border border-border bg-surface-3 text-fg shrink-0 max-w-[50%]"
        >
          <option value="">Default</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label ?? c.id}
              {c.is_default ? " · default" : ""}
            </option>
          ))}
        </select>
      ) : (
        <div className="text-[11px] text-fg-muted bg-surface-3 px-2 py-1 rounded whitespace-nowrap shrink-0">
          {defaultLabel}
        </div>
      )}
    </div>
  );
}
