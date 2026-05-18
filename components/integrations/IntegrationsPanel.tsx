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
        <Key size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg mr-auto">Integrations</h2>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading && defs.length === 0 && <p className="text-fg-faint text-sm py-6 text-center">Loading…</p>}
        {!loading && defs.length === 0 && <p className="text-fg-faint text-sm py-6 text-center">No integrations available.</p>}
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

  async function connectOAuth(provider: "gmail" | "outlook") {
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
      const startFn = provider === "gmail"
        ? api.integrations.gmailOauthStart
        : api.integrations.outlookOauthStart;
      const statusFn = provider === "gmail"
        ? api.integrations.gmailOauthStatus
        : api.integrations.outlookOauthStatus;
      const label = provider === "gmail" ? "Gmail" : "Outlook";

      const r = await startFn({ client_id: clientId, client_secret: clientSecret });
      popupRef.current = window.open(r.authorize_url, `jarela-${provider}-oauth`, "width=560,height=720");
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
          const s = await statusFn(r.state);
          if (s.status === "done") {
            if (pollRef.current) clearInterval(pollRef.current);
            setConnecting(false);
            setTestResult({ ok: true, message: `Connected to ${label}. Refresh token saved.` });
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
    // status?.values intentionally omitted — only re-seed on a real save
    // (signalled by updated_at). Including .values would clobber user edits.
  }, [status?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <div className={`w-1.5 h-1.5 rounded-full mt-1.5 ${configured ? "bg-emerald-500" : "bg-fg-faint"}`} />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-fg">{def.label}</h3>
          <p className="text-[11px] text-fg-faint mt-0.5 leading-snug">{def.description}</p>
        </div>
      </div>

      <div className="px-3 py-3 space-y-2">
        {def.name === "gmail" && <GmailSetupGuide />}
        {def.name === "outlook" && <OutlookSetupGuide />}
        {def.fields.map((f) => (
          <label key={f.key} className="block text-xs text-fg-subtle">
            {f.label}{f.required && <span className="text-rose-700 dark:text-rose-400 ml-0.5">*</span>}
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
              className="mt-1 w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-3 text-fg font-mono"
            />
          </label>
        ))}

        {error && (
          <div className="px-2 py-1.5 rounded bg-rose-950/40 border border-rose-800 text-xs text-rose-700 dark:text-rose-300">
            {error}
          </div>
        )}
        {testResult && (
          <div className={`px-2 py-1.5 rounded border text-xs flex items-center gap-1.5 ${
            testResult.ok
              ? "bg-emerald-950/30 border-emerald-800 text-emerald-700 dark:text-emerald-300"
              : "bg-rose-950/30 border-rose-800 text-rose-700 dark:text-rose-300"
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
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-border text-fg-muted hover:bg-surface-3 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {testing ? <Loader2 size={11} className="animate-spin" /> : <ExternalLink size={11} />}
            Test
          </button>
          {def.name === "gmail" && (
            <button
              onClick={() => connectOAuth("gmail")}
              disabled={connecting}
              title="Authorize Gmail + Calendar via Google OAuth — opens a browser window"
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-border text-fg-muted hover:bg-surface-3 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {connecting ? <Loader2 size={11} className="animate-spin" /> : <LinkIcon size={11} />}
              {connecting ? "Waiting…" : "Connect Gmail"}
            </button>
          )}
          {def.name === "outlook" && (
            <button
              onClick={() => connectOAuth("outlook")}
              disabled={connecting}
              title="Authorize Outlook + Calendar via Microsoft OAuth — opens a browser window"
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-border text-fg-muted hover:bg-surface-3 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {connecting ? <Loader2 size={11} className="animate-spin" /> : <LinkIcon size={11} />}
              {connecting ? "Waiting…" : "Connect Outlook"}
            </button>
          )}
          {configured && (
            <button
              onClick={clear}
              className="ml-auto inline-flex items-center gap-1 px-2 py-1.5 text-xs text-fg-faint hover:text-rose-700 dark:hover:text-rose-400"
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
    <details className="rounded border border-border/60 bg-surface-3/40 text-xs text-fg-muted">
      <summary className="cursor-pointer select-none px-2.5 py-1.5 text-fg hover:bg-surface-3">
        Setup guide (first-time only)
      </summary>
      <div className="px-3 py-2.5 space-y-3 border-t border-border/60 leading-relaxed">
        <p className="text-amber-700 dark:text-amber-300/90 text-[11px] border border-amber-400/30 bg-amber-400/5 rounded px-2 py-1.5">
          <strong>Upgrading from an earlier version?</strong> Click <strong>Connect Gmail</strong> again so
          Google can grant the new Calendar scope &mdash; otherwise calendar tools will fail with a 403.
        </p>
        <p className="text-fg-subtle">
          You only need to do this once per Google account. The end result is a <code className="text-fg">client_id</code>,
          {" "}<code className="text-fg">client_secret</code> pair you paste below. Then click
          {" "}<strong className="text-fg">Connect Gmail</strong> to authorize Gmail + Calendar access.
        </p>

        <Step n={1} title="Create or pick a Google Cloud project">
          Open <Ext href="https://console.cloud.google.com/projectcreate">console.cloud.google.com/projectcreate</Ext>{" "}
          and create a project (any name). If you already have one, just select it in the top bar.
        </Step>

        <Step n={2} title="Enable the Gmail and Calendar APIs">
          Enable <Ext href="https://console.cloud.google.com/apis/library/gmail.googleapis.com">Gmail API</Ext>{" "}
          <strong>and</strong> <Ext href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com">Google Calendar API</Ext>.
          Click <strong>Enable</strong> on each and wait a few seconds for them to activate.
        </Step>

        <Step n={3} title="Configure the OAuth consent screen">
          Go to <Ext href="https://console.cloud.google.com/auth/branding">Auth Platform → Branding</Ext>.
          Set <strong>User type: External</strong>, fill in an app name and your email, save.
          Then in <Ext href="https://console.cloud.google.com/auth/scopes">Data Access → Scopes</Ext>{" "}
          click <strong>Add or remove scopes</strong> and add all three:
          <ul className="list-disc ml-5 mt-1 text-fg-subtle">
            <li><code className="text-fg">.../auth/gmail.modify</code></li>
            <li><code className="text-fg">.../auth/gmail.compose</code></li>
            <li><code className="text-fg">.../auth/calendar.events</code></li>
          </ul>
          Finally, in <Ext href="https://console.cloud.google.com/auth/audience">Audience</Ext>{" "}
          add your own Gmail address as a <strong>Test user</strong>. (Leaving the app in Testing
          mode is fine &mdash; you don&apos;t need to publish or verify it for personal use.)
        </Step>

        <Step n={4} title="Create the OAuth client (Desktop type)">
          Go to <Ext href="https://console.cloud.google.com/auth/clients">Clients</Ext> →{" "}
          <strong>Create client</strong>.
          <ul className="list-disc ml-5 mt-1 text-fg-subtle">
            <li><strong>Application type:</strong> <span className="text-fg">Desktop app</span>{" "}
              (this matters — Web app types require pre-registering redirect URIs and will fail with
              <code className="text-fg"> redirect_uri_mismatch</code>).</li>
            <li><strong>Name:</strong> anything, e.g. <code className="text-fg">Jarela</code>.</li>
          </ul>
          After it&apos;s created, copy the <strong>Client ID</strong> and <strong>Client secret</strong>{" "}
          shown in the popup (or click the download icon to get the JSON — the values are under{" "}
          <code className="text-fg">installed.client_id</code> /{" "}
          <code className="text-fg">installed.client_secret</code>).
        </Step>

        <Step n={5} title="Paste and connect">
          Paste them into the two fields below, click <strong>Save</strong>, then{" "}
          <strong>Connect Gmail</strong>. A Google consent window opens — approve it and the tab
          will close itself. Hit <strong>Test</strong> to confirm.
        </Step>

        <div className="mt-2 pt-2 border-t border-border/60 text-[11px] text-fg-faint">
          <strong className="text-fg-subtle">Troubleshooting:</strong>
          <ul className="list-disc ml-5 mt-1 space-y-0.5">
            <li><code>redirect_uri_mismatch</code> → your client is a <em>Web</em> app. Create a fresh
              one as <em>Desktop app</em> instead, or add{" "}
              <code className="text-fg-muted">http://localhost:4312/api/v1/integrations/gmail/oauth/callback</code>{" "}
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
      <div className="flex-none w-5 h-5 rounded-full bg-surface-3 border border-border text-[10px] text-fg-muted flex items-center justify-center font-mono">
        {n}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-fg font-medium">{title}</div>
        <div className="text-fg-subtle mt-0.5">{children}</div>
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
      className="text-sky-700 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300 underline decoration-dotted underline-offset-2"
    >
      {children}
    </a>
  );
}

// Inline walkthrough for the Outlook integration card. The Azure portal UI
// shifts less than GCP's but still drifts; keep instructions concrete and
// link to the exact blade rather than describing breadcrumbs.
function OutlookSetupGuide() {
  return (
    <details className="rounded border border-border/60 bg-surface-3/40 text-xs text-fg-muted">
      <summary className="cursor-pointer select-none px-2.5 py-1.5 text-fg hover:bg-surface-3">
        Setup guide (first-time only)
      </summary>
      <div className="px-3 py-2.5 space-y-3 border-t border-border/60 leading-relaxed">
        <p className="text-fg-subtle">
          You only need to do this once per Microsoft account. The end result is an{" "}
          <code className="text-fg">Application (client) ID</code> +{" "}
          <code className="text-fg">client secret value</code> pair you paste below. Then click{" "}
          <strong className="text-fg">Connect Outlook</strong> to authorize Mail + Calendar access.
          Free &mdash; no Azure subscription required.
        </p>

        <Step n={1} title="Sign in to the Azure portal">
          Open <Ext href="https://portal.azure.com">portal.azure.com</Ext> with the Microsoft account
          whose Outlook data you want to access. If a banner asks you to start a free Azure
          subscription, <strong>skip it</strong> &mdash; app registrations live under the free
          identity tier.
        </Step>

        <Step n={2} title="Create the app registration">
          Open <Ext href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade">Microsoft Entra &rarr; App registrations</Ext>
          {" "}(or the same blade in the <Ext href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade">Azure portal</Ext>),
          then click <strong>+ New registration</strong> in the toolbar.
          <ul className="list-disc ml-5 mt-1 text-fg-subtle">
            <li><strong>Name:</strong> anything, e.g. <code className="text-fg">Jarela</code>.</li>
            <li><strong>Supported account types:</strong>{" "}
              <span className="text-fg">
                Accounts in any organizational directory (Any Microsoft Entra ID tenant -
                Multitenant) and personal Microsoft accounts
              </span>{" "}
              &mdash; this is the broadest option and works for both <code>@outlook.com</code> and
              work/school accounts.</li>
            <li><strong>Redirect URI:</strong> select <strong>Web</strong> and paste{" "}
              <code className="text-fg">{typeof window !== "undefined" ? window.location.origin : "http://localhost:4312"}/api/v1/integrations/outlook/oauth/callback</code>.{" "}
              Microsoft will reject the auth flow with <code>redirect_uri_mismatch</code> if this
              doesn&apos;t match exactly.</li>
          </ul>
          Click <strong>Register</strong>. Copy the <strong>Application (client) ID</strong> from
          the overview page.
        </Step>

        <Step n={3} title="Create a client secret">
          On the app&apos;s page, open <strong>Certificates &amp; secrets</strong> &rarr;{" "}
          <strong>Client secrets</strong> &rarr; <strong>New client secret</strong>. Pick a
          description and expiration (24 months is reasonable). Click <strong>Add</strong>.
          {" "}<strong className="text-fg">Immediately copy the &quot;Value&quot; column</strong>
          {" "}&mdash; it&apos;s only shown once. (The &quot;Secret ID&quot; column is NOT the secret;
          ignore it.)
        </Step>

        <Step n={4} title="Add API permissions">
          Open <strong>API permissions</strong> &rarr; <strong>Add a permission</strong> &rarr;{" "}
          <strong>Microsoft Graph</strong> &rarr; <strong>Delegated permissions</strong>. Tick all four:
          <ul className="list-disc ml-5 mt-1 text-fg-subtle">
            <li><code className="text-fg">offline_access</code> &mdash; required for refresh tokens.</li>
            <li><code className="text-fg">User.Read</code> &mdash; basic profile for the Test button.</li>
            <li><code className="text-fg">Mail.ReadWrite</code> &mdash; search/read/draft/move mail.</li>
            <li><code className="text-fg">Calendars.ReadWrite</code> &mdash; manage calendar events.</li>
          </ul>
          Click <strong>Add permissions</strong>. Personal accounts grant these themselves at the
          consent screen. Work/school accounts may require admin consent &mdash; if you&apos;re not
          the tenant admin, ask IT.
        </Step>

        <Step n={5} title="Paste and connect">
          Paste the <strong>Application (client) ID</strong> and the secret <strong>Value</strong>
          {" "}from step 3 into the two fields below, click <strong>Save</strong>, then{" "}
          <strong>Connect Outlook</strong>. A Microsoft consent window opens &mdash; approve it and
          the tab will close itself. Hit <strong>Test</strong> to confirm.
        </Step>

        <div className="mt-2 pt-2 border-t border-border/60 text-[11px] text-fg-faint">
          <strong className="text-fg-subtle">Troubleshooting:</strong>
          <ul className="list-disc ml-5 mt-1 space-y-0.5">
            <li><code>redirect_uri_mismatch</code> / <code>AADSTS50011</code> &rarr; the redirect
              URI on your Azure app doesn&apos;t exactly match the one Jarela sent. Compare
              character-for-character (trailing slash, http vs https, port).</li>
            <li><code>invalid_client</code> / <code>AADSTS7000215</code> &rarr; you pasted the
              Secret ID instead of the Secret Value. Regenerate the secret and copy the Value
              column.</li>
            <li><code>AADSTS65001</code> &rarr; admin consent required. For work/school accounts
              ask your IT admin to grant tenant consent on your app.</li>
            <li><code>AADSTS900144</code> &rarr; missing scope on the token call. Update Jarela.</li>
            <li>Tokens are tied to the client secret&apos;s expiration. When the secret expires,
              create a new one in Azure and reconnect.</li>
          </ul>
        </div>
      </div>
    </details>
  );
}
