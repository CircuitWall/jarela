"use client";
import { CheckCircle2, ExternalLink, Key, Link as LinkIcon, Loader2, Trash2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { IntegrationDefinition, IntegrationStatus } from "@/api/types";

const SECRET_MASK = "********";

export function IntegrationsPanel() {
  const [defs, setDefs] = useState<IntegrationDefinition[]>([]);
  const [statuses, setStatuses] = useState<Record<string, IntegrationStatus>>({});
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await api.integrations.list();
      setDefs(res.definitions);
      setStatuses(Object.fromEntries(res.statuses.map((s) => [s.name, s])));
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <Key size={14} className="text-zinc-400" />
        <h2 className="text-sm font-semibold text-zinc-100 mr-auto">Integrations</h2>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading && defs.length === 0 && <p className="text-zinc-500 text-sm py-6 text-center">Loading…</p>}
        {!loading && defs.length === 0 && <p className="text-zinc-500 text-sm py-6 text-center">No integrations available.</p>}
        {defs.map((def) => (
          <IntegrationCard
            key={def.name}
            definition={def}
            status={statuses[def.name]}
            onChanged={load}
          />
        ))}
      </div>
    </div>
  );
}

function IntegrationCard({
  definition: def,
  status,
  onChanged,
}: {
  definition: IntegrationDefinition;
  status?: IntegrationStatus;
  onChanged: () => void;
}) {
  // Form values are seeded from status (with secrets masked) so the user sees
  // their saved config and can edit only what they want.
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(status?.values ?? {}) }));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Stop any in-flight OAuth polling on unmount.
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  async function connectGmail() {
    setError(null);
    setTestResult(null);
    const clientId = values.client_id?.trim();
    const clientSecret = values.client_secret?.trim();
    // Allow empty when the user has already saved creds (backend falls back).
    if (!status?.configured && (!clientId || !clientSecret)) {
      setError("Enter the OAuth client ID and client secret first.");
      return;
    }
    setConnecting(true);
    try {
      const r = await api.integrations.gmailOauthStart({ client_id: clientId, client_secret: clientSecret });
      popupRef.current = window.open(r.authorize_url, "jarela-gmail-oauth", "width=560,height=720");
      if (!popupRef.current) {
        setError("Browser blocked the OAuth popup. Allow popups for this site and retry.");
        setConnecting(false);
        return;
      }
      const startedAt = Date.now();
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        if (Date.now() - startedAt > 10 * 60_000) {
          if (pollRef.current) clearInterval(pollRef.current);
          setConnecting(false);
          setError("Timed out waiting for authorization.");
          return;
        }
        try {
          const s = await api.integrations.gmailOauthStatus(r.state);
          if (s.status === "done") {
            if (pollRef.current) clearInterval(pollRef.current);
            setConnecting(false);
            setTestResult({ ok: true, message: "Connected. Refresh token saved." });
            try { popupRef.current?.close(); } catch { /* ignore */ }
            onChanged();
          } else if (s.status === "error") {
            if (pollRef.current) clearInterval(pollRef.current);
            setConnecting(false);
            setError(s.error ?? "Authorization failed.");
          } else if (s.status === "unknown") {
            if (pollRef.current) clearInterval(pollRef.current);
            setConnecting(false);
            setError("Authorization session expired.");
          }
        } catch (e) {
          if (pollRef.current) clearInterval(pollRef.current);
          setConnecting(false);
          setError(e instanceof Error ? e.message : String(e));
        }
      }, 1500);
    } catch (e) {
      setConnecting(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Re-seed when the status changes (e.g. after save returns updated mask).
  useEffect(() => {
    setValues({ ...(status?.values ?? {}) });
  }, [status?.updated_at]);

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const result = await api.integrations.save(def.name, values);
      setTestResult(null);
      setValues({ ...result.values });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.integrations.test(def.name);
      if (r.ok) {
        const detail = r.detail as { displayName?: string; email?: string } | undefined;
        setTestResult({
          ok: true,
          message: detail?.displayName ? `Connected as ${detail.displayName}` : "Connection ok",
        });
      } else {
        setTestResult({ ok: false, message: r.error ?? "Test failed" });
      }
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }

  async function clear() {
    if (!confirm(`Remove saved credentials for ${def.label}?`)) return;
    await api.integrations.delete(def.name);
    setValues({});
    setTestResult(null);
    onChanged();
  }

  const configured = status?.configured;

  return (
    <div className="mb-3 rounded-lg border border-border bg-surface-2 overflow-hidden">
      <div className="px-3 py-2.5 border-b border-border/60 flex items-start gap-2">
        <div className={`w-1.5 h-1.5 rounded-full mt-1.5 ${configured ? "bg-emerald-500" : "bg-zinc-600"}`} />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-zinc-100">{def.label}</h3>
          <p className="text-[11px] text-zinc-500 mt-0.5 leading-snug">{def.description}</p>
        </div>
      </div>

      <div className="px-3 py-3 space-y-2">
        {def.name === "gmail" && <GmailSetupGuide />}
        {def.fields.map((f) => (
          <label key={f.key} className="block text-xs text-zinc-400">
            {f.label}{f.required && <span className="text-rose-400 ml-0.5">*</span>}
            <input
              type={f.secret ? "password" : "text"}
              value={values[f.key] ?? ""}
              onChange={(e) => setValues((p) => ({ ...p, [f.key]: e.target.value }))}
              onFocus={(e) => {
                // Clicking a masked secret field clears it so the user can type a new value
                // without manually selecting and replacing the dots.
                if (f.secret && e.target.value === SECRET_MASK) {
                  setValues((p) => ({ ...p, [f.key]: "" }));
                }
              }}
              placeholder={f.placeholder}
              className="mt-1 w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-3 text-zinc-100 font-mono"
            />
          </label>
        ))}

        {error && (
          <div className="px-2 py-1.5 rounded bg-rose-950/40 border border-rose-800 text-xs text-rose-300">
            {error}
          </div>
        )}
        {testResult && (
          <div className={`px-2 py-1.5 rounded border text-xs flex items-center gap-1.5 ${
            testResult.ok
              ? "bg-emerald-950/30 border-emerald-800 text-emerald-300"
              : "bg-rose-950/30 border-rose-800 text-rose-300"
          }`}>
            {testResult.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
            <span className="truncate">{testResult.message}</span>
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={save}
            disabled={saving}
            className="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            onClick={test}
            disabled={testing || !configured}
            title={!configured ? "Save credentials first" : "Test the connection"}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-border text-zinc-300 hover:bg-surface-3 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {testing ? <Loader2 size={11} className="animate-spin" /> : <ExternalLink size={11} />}
            Test
          </button>
          {def.name === "gmail" && (
            <button
              onClick={connectGmail}
              disabled={connecting}
              title="Authorize Gmail via Google OAuth — opens a browser window"
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-border text-zinc-300 hover:bg-surface-3 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {connecting ? <Loader2 size={11} className="animate-spin" /> : <LinkIcon size={11} />}
              {connecting ? "Waiting…" : "Connect Gmail"}
            </button>
          )}
          {configured && (
            <button
              onClick={clear}
              className="ml-auto inline-flex items-center gap-1 px-2 py-1.5 text-xs text-zinc-500 hover:text-rose-400"
              title="Remove saved credentials"
            >
              <Trash2 size={11} /> Clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Inline walkthrough rendered inside the Gmail integration card. Google's GCP
// console UI changes often; keep this in sync with reality and prefer linking
// directly to the right page over screenshots.
function GmailSetupGuide() {
  return (
    <details className="rounded border border-border/60 bg-surface-3/40 text-xs text-zinc-300">
      <summary className="cursor-pointer select-none px-2.5 py-1.5 text-zinc-200 hover:bg-surface-3">
        Setup guide (first-time only)
      </summary>
      <div className="px-3 py-2.5 space-y-3 border-t border-border/60 leading-relaxed">
        <p className="text-zinc-400">
          You only need to do this once per Google account. The end result is a <code className="text-zinc-200">client_id</code>,
          {" "}<code className="text-zinc-200">client_secret</code> pair you paste below. Then click
          {" "}<strong className="text-zinc-200">Connect Gmail</strong> to authorize.
        </p>

        <Step n={1} title="Create or pick a Google Cloud project">
          Open <Ext href="https://console.cloud.google.com/projectcreate">console.cloud.google.com/projectcreate</Ext>{" "}
          and create a project (any name). If you already have one, just select it in the top bar.
        </Step>

        <Step n={2} title="Enable the Gmail API">
          Go to <Ext href="https://console.cloud.google.com/apis/library/gmail.googleapis.com">APIs &amp; Services → Library → Gmail API</Ext>{" "}
          and click <strong>Enable</strong>. Wait a few seconds for it to activate.
        </Step>

        <Step n={3} title="Configure the OAuth consent screen">
          Go to <Ext href="https://console.cloud.google.com/auth/branding">Auth Platform → Branding</Ext>.
          Set <strong>User type: External</strong>, fill in an app name and your email, save.
          Then in <Ext href="https://console.cloud.google.com/auth/scopes">Data Access → Scopes</Ext>{" "}
          click <strong>Add or remove scopes</strong> and add both:
          <ul className="list-disc ml-5 mt-1 text-zinc-400">
            <li><code className="text-zinc-200">.../auth/gmail.modify</code></li>
            <li><code className="text-zinc-200">.../auth/gmail.compose</code></li>
          </ul>
          Finally, in <Ext href="https://console.cloud.google.com/auth/audience">Audience</Ext>{" "}
          add your own Gmail address as a <strong>Test user</strong>. (Leaving the app in Testing
          mode is fine — you don't need to publish or verify it for personal use.)
        </Step>

        <Step n={4} title="Create the OAuth client (Desktop type)">
          Go to <Ext href="https://console.cloud.google.com/auth/clients">Clients</Ext> →{" "}
          <strong>Create client</strong>.
          <ul className="list-disc ml-5 mt-1 text-zinc-400">
            <li><strong>Application type:</strong> <span className="text-zinc-200">Desktop app</span>{" "}
              (this matters — Web app types require pre-registering redirect URIs and will fail with
              <code className="text-zinc-200"> redirect_uri_mismatch</code>).</li>
            <li><strong>Name:</strong> anything, e.g. <code className="text-zinc-200">Jarela</code>.</li>
          </ul>
          After it's created, copy the <strong>Client ID</strong> and <strong>Client secret</strong>{" "}
          shown in the popup (or click the download icon to get the JSON — the values are under{" "}
          <code className="text-zinc-200">installed.client_id</code> /{" "}
          <code className="text-zinc-200">installed.client_secret</code>).
        </Step>

        <Step n={5} title="Paste and connect">
          Paste them into the two fields below, click <strong>Save</strong>, then{" "}
          <strong>Connect Gmail</strong>. A Google consent window opens — approve it and the tab
          will close itself. Hit <strong>Test</strong> to confirm.
        </Step>

        <div className="mt-2 pt-2 border-t border-border/60 text-[11px] text-zinc-500">
          <strong className="text-zinc-400">Troubleshooting:</strong>
          <ul className="list-disc ml-5 mt-1 space-y-0.5">
            <li><code>redirect_uri_mismatch</code> → your client is a <em>Web</em> app. Create a fresh
              one as <em>Desktop app</em> instead, or add{" "}
              <code className="text-zinc-300">http://localhost:4312/api/v1/integrations/gmail/oauth/callback</code>{" "}
              to its Authorized redirect URIs.</li>
            <li><code>access_denied</code> → your Gmail address isn&apos;t in the Test users list
              (step 3, last paragraph).</li>
            <li>&quot;Google did not return a refresh_token&quot; → you previously authorized this
              client. Revoke it at{" "}
              <Ext href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</Ext>{" "}
              and click Connect Gmail again.</li>
            <li>Token works for ~6 months of inactivity, then Google may revoke it. Just click
              Connect Gmail again to refresh.</li>
          </ul>
        </div>
      </div>
    </details>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <div className="flex-none w-5 h-5 rounded-full bg-surface-3 border border-border text-[10px] text-zinc-300 flex items-center justify-center font-mono">
        {n}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-zinc-200 font-medium">{title}</div>
        <div className="text-zinc-400 mt-0.5">{children}</div>
      </div>
    </div>
  );
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sky-400 hover:text-sky-300 underline decoration-dotted underline-offset-2"
    >
      {children}
    </a>
  );
}
