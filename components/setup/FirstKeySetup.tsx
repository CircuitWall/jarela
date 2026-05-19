"use client";

// First-key setup screen (ADR-0010). Three fields, one button. Once a key
// validates and saves, the user lands in the chat and the agent takes over
// the rest of onboarding.

import { useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { api } from "@/api/client";

type Provider = "anthropic" | "openai" | "gemini" | "deepseek";

const PROVIDER_INFO: Record<
  Provider,
  { label: string; signupUrl: string; placeholder: string; defaultModel: string }
> = {
  anthropic: {
    label: "Anthropic (Claude)",
    signupUrl: "https://console.anthropic.com/settings/keys",
    placeholder: "sk-ant-…",
    defaultModel: "claude-opus-4-7",
  },
  openai: {
    label: "OpenAI (GPT)",
    signupUrl: "https://platform.openai.com/api-keys",
    placeholder: "sk-…",
    defaultModel: "gpt-4o",
  },
  gemini: {
    label: "Google (Gemini)",
    signupUrl: "https://aistudio.google.com/apikey",
    placeholder: "AIza…",
    defaultModel: "gemini-2.5-pro",
  },
  deepseek: {
    label: "DeepSeek",
    signupUrl: "https://platform.deepseek.com/api_keys",
    placeholder: "sk-…",
    defaultModel: "deepseek-chat",
  },
};

interface TestResult {
  ok: boolean;
  models?: string[];
  error?: string;
}

export function FirstKeySetup() {
  const [provider, setProvider] = useState<Provider>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(PROVIDER_INFO.anthropic.defaultModel);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function pickProvider(p: Provider) {
    setProvider(p);
    setModel(PROVIDER_INFO[p].defaultModel);
    setTest(null);
    setSaveError(null);
  }

  async function runTest() {
    if (!apiKey.trim()) return;
    setTesting(true);
    setTest(null);
    setSaveError(null);
    try {
      const res = await fetch("/api/v1/setup/test-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim() }),
      });
      const data = (await res.json()) as TestResult;
      setTest(data);
      if (data.ok && data.models && data.models.length > 0 && !data.models.includes(model)) {
        setModel(data.models[0]);
      }
    } catch (err) {
      setTest({ ok: false, error: `network error: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (!apiKey.trim() || !model.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const name = `${provider}-default`;
      await api.models.create(name, {
        provider,
        model_id: model.trim(),
        params: { api_key: apiKey.trim() },
        is_default: true,
      });
      window.location.href = "/";
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const info = PROVIDER_INFO[provider];

  return (
    <main className="min-h-screen flex items-center justify-center bg-surface text-fg px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="flex items-center gap-3 mb-8">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark-transparent.png" alt="" className="h-10 w-auto" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Welcome to Jarela</h1>
            <p className="text-sm text-fg-subtle">
              One key to get started — your assistant handles the rest.
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-surface-2 p-5 space-y-5">
          <div className="space-y-2">
            <label className="text-xs font-medium text-fg-subtle">Provider</label>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(PROVIDER_INFO) as Provider[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => pickProvider(p)}
                  className={`px-3 py-2 rounded border text-sm text-left transition ${
                    provider === p
                      ? "border-emerald-500 bg-emerald-950/30 text-fg"
                      : "border-border hover:border-fg-faint text-fg-muted"
                  }`}
                >
                  {PROVIDER_INFO[p].label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <label htmlFor="api-key" className="text-xs font-medium text-fg-subtle">
                API key
              </label>
              <a
                href={info.signupUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-xs text-emerald-500 hover:underline inline-flex items-center gap-1"
              >
                I don&apos;t have one yet <ExternalLink size={11} />
              </a>
            </div>
            <input
              id="api-key"
              type="password"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setTest(null); }}
              placeholder={info.placeholder}
              className="w-full px-3 py-2 rounded border border-border bg-surface text-fg placeholder:text-fg-faint focus:border-emerald-500 focus:outline-none font-mono text-sm"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-[11px] text-fg-faint">
              Stored encrypted at rest in your local database. Never sent anywhere except
              the provider you selected.
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="model" className="text-xs font-medium text-fg-subtle">
              Default model
            </label>
            {test?.ok && test.models && test.models.length > 0 ? (
              <select
                id="model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full px-3 py-2 rounded border border-border bg-surface text-fg text-sm"
              >
                {test.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="model"
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full px-3 py-2 rounded border border-border bg-surface text-fg text-sm font-mono"
              />
            )}
          </div>

          {test && (
            <div
              className={`rounded p-3 text-sm flex items-start gap-2 ${
                test.ok
                  ? "border border-emerald-700/50 bg-emerald-950/30 text-emerald-300"
                  : "border border-rose-700/50 bg-rose-950/30 text-rose-300"
              }`}
            >
              {test.ok ? (
                <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
              ) : (
                <XCircle size={16} className="mt-0.5 shrink-0" />
              )}
              <span>
                {test.ok
                  ? `Key validated. ${test.models?.length ?? 0} models available.`
                  : test.error}
              </span>
            </div>
          )}

          {saveError && (
            <div className="rounded p-3 text-sm border border-rose-700/50 bg-rose-950/30 text-rose-300">
              Save failed: {saveError}
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={runTest}
              disabled={testing || !apiKey.trim()}
              className="flex-1 px-4 py-2 rounded border border-border text-sm hover:border-fg-faint disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              {testing ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Testing
                </>
              ) : (
                <>
                  <ShieldCheck size={14} /> Test connection
                </>
              )}
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || !test?.ok || !model.trim()}
              className="flex-1 px-4 py-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:hover:bg-emerald-700 text-white text-sm inline-flex items-center justify-center gap-2"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : null}
              Save and continue
            </button>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-fg-faint">
          After this screen, your assistant can help you connect Gmail, Outlook, Atlassian,
          and more — no extra menus to navigate.
        </p>
      </div>
    </main>
  );
}
