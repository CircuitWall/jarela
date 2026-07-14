import { useMemo } from "react";
import type { Credential } from "@/api/types";
import type { AgentEditorForm } from "./useAgentEditorForm";
import { Section } from "./Section";

// Renders a per-tool credential picker for every enabled tool whose
// integration has at least two credentials configured. Single-credential
// integrations are hidden — there is nothing to pick. Tools whose
// integration we can't infer (no provider matches the tool name's prefix
// or category) are also hidden, since the override would be silently
// ignored by the resolver.
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

  const providersWithMultipleCredentials = useMemo(
    () => [...credsByProvider.keys()].filter((p) => (credsByProvider.get(p) ?? []).length >= 2),
    [credsByProvider],
  );

  // Build {toolName: provider} only for tools whose integration has 2+
  // credentials. Heuristic: a tool belongs to provider P if its name
  // starts with `${P}_` (matches gmail_*, github_*, outlook_*, …) or if
  // its category equals the integration name (case-insensitive).
  const pickableTools = useMemo(() => {
    const providers = providersWithMultipleCredentials;
    if (providers.length === 0) return [] as Array<{ name: string; provider: string }>;
    const toolByName = new Map(tools.map((t) => [t.name, t]));
    const out: Array<{ name: string; provider: string }> = [];
    for (const toolName of selectedTools) {
      const t = toolByName.get(toolName);
      const match = providers.find((p) => {
        if (toolName.toLowerCase().startsWith(`${p.toLowerCase()}_`)) return true;
        if (t?.category && t.category.toLowerCase() === p.toLowerCase()) return true;
        return false;
      });
      if (match) out.push({ name: toolName, provider: match });
    }
    return out;
  }, [providersWithMultipleCredentials, selectedTools, tools]);

  if (providersWithMultipleCredentials.length === 0) return null;

  if (pickableTools.length === 0) {
    return (
      <Section step={4} title="Tool credentials">
        <p className="text-[11px] text-fg-faint">
          Multiple credentials are saved for {formatProviderList(providersWithMultipleCredentials)}. Select matching tools above to pin a specific credential; otherwise tools use the provider&apos;s default credential.
        </p>
      </Section>
    );
  }

  return (
    <Section step={4} title="Tool credentials">
      <p className="text-[11px] text-fg-faint mb-2">
        Pin a specific credential per tool. Leave on <em>Default</em> to use the
        provider&apos;s default credential; adding another credential does not create
        duplicate tool names.
      </p>
      <div className="space-y-1.5">
        {pickableTools.map(({ name, provider }) => (
          <ToolCredentialRow
            key={name}
            toolName={name}
            options={credsByProvider.get(provider) ?? []}
            selectedId={form.toolCredentials[name] ?? ""}
            onChange={(id) => form.setToolCredentialFor(name, id || null)}
          />
        ))}
      </div>
    </Section>
  );
}

function formatProviderList(providers: string[]): string {
  if (providers.length === 1) return providers[0];
  if (providers.length === 2) return `${providers[0]} and ${providers[1]}`;
  return `${providers.slice(0, -1).join(", ")}, and ${providers[providers.length - 1]}`;
}

function ToolCredentialRow({
  toolName,
  options,
  selectedId,
  onChange,
}: {
  toolName: string;
  options: Credential[];
  selectedId: string;
  onChange: (id: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="font-mono text-fg-muted flex-1 truncate">{toolName}</span>
      <select
        value={selectedId}
        onChange={(e) => onChange(e.target.value)}
        className="px-2 py-1 text-xs rounded border border-border bg-surface-3 text-fg max-w-[60%]"
      >
        <option value="">Default</option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label ?? c.id}
            {c.is_default ? " · default" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
