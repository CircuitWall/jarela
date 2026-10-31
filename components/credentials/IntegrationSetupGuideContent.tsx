"use client";


// Inline walkthrough rendered inside the Gmail integration card. Google's GCP
// console UI changes often; keep this in sync with reality and prefer linking
// directly to the right page over screenshots.
export function GmailSetupGuideContent() {
  return (
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
            <li><code className="text-fg">.../auth/calendar.readonly</code></li>
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
export function OutlookSetupGuideContent() {
  return (
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
  );
}


export function ClaudeCodeSetupGuideContent() {
  return (
      <div className="px-3 py-2.5 space-y-3 border-t border-border/60 leading-relaxed">
        <p className="text-fg-subtle">
          This integration powers the <code className="text-fg">claude_delegate</code> tool. Jarela runs your local Claude Code CLI and can inject a UI-managed API key so the tool does not depend on your shell session.
        </p>

        <Step n={1} title="Install Claude Code">
          Install the CLI using the official installer or your package manager. After install, running <code className="text-fg">claude --version</code> in a terminal should print a version string.
        </Step>

        <Step n={2} title="Set the CLI path only if needed">
          Leave <strong>CLI path</strong> blank when <code className="text-fg">claude</code> is already on PATH. Fill it in only when Jarela should use a specific binary, for example <code className="text-fg">/opt/homebrew/bin/claude</code>.
        </Step>

        <Step n={3} title="Choose how Jarela should authenticate Claude Code">
          <ul className="list-disc ml-5 mt-1 space-y-0.5 text-fg-subtle">
            <li>Paste an <strong>Anthropic API key</strong> here to make the UI-managed credential the primary path for Jarela-run Claude sessions.</li>
            <li>Or set an <strong>Anthropic auth token</strong> if your Claude setup uses token-based auth instead of an API key.</li>
            <li>Or leave the key blank and rely on your existing Claude Code login or settings outside Jarela.</li>
          </ul>
          If you save these fields, Jarela injects them into the Claude Code subprocess directly instead of depending on shell exports.
        </Step>

        <Step n={4} title="Choose launch defaults">
          The <strong>Launch defaults</strong> section controls how Jarela starts delegated Claude sessions when an agent does not pass an explicit override:
          <ul className="list-disc ml-5 mt-1 space-y-0.5 text-fg-subtle">
            <li><code className="text-fg">default_model</code> chooses the delegate model, such as <code className="text-fg">sonnet</code> or <code className="text-fg">opus</code>.</li>
            <li><code className="text-fg">default_tools</code> chooses Claude&apos;s tool set, such as <code className="text-fg">default</code> or <code className="text-fg">Read,Grep,WebSearch</code>.</li>
            <li><code className="text-fg">default_add_dirs</code> grants extra directories, separated by commas or new lines.</li>
            <li><code className="text-fg">default_permission_mode</code>, <code className="text-fg">default_allow_unsafe</code>, and <code className="text-fg">default_background</code> set the default execution posture.</li>
          </ul>
          Jarela still applies its safety gate before spawning Claude, so safe mode blocks delegation and mostly-safe mode stays read-only unless unsafe execution is explicitly enabled.
        </Step>

        <Step n={5} title="Optional Claude model environment defaults">
          You can also set optional Claude runtime env defaults in the <strong>Connection</strong> section:
          <ul className="list-disc ml-5 mt-1 space-y-0.5 text-fg-subtle">
            <li><code className="text-fg">base_url</code> &rarr; <code className="text-fg">ANTHROPIC_BASE_URL</code></li>
            <li><code className="text-fg">default_opus_model</code> &rarr; <code className="text-fg">ANTHROPIC_DEFAULT_OPUS_MODEL</code></li>
            <li><code className="text-fg">default_sonnet_model</code> &rarr; <code className="text-fg">ANTHROPIC_DEFAULT_SONNET_MODEL</code></li>
            <li><code className="text-fg">default_haiku_model</code> &rarr; <code className="text-fg">ANTHROPIC_DEFAULT_HAIKU_MODEL</code></li>
          </ul>
          Leave any of these blank if you do not need overrides.
        </Step>

        <Step n={6} title="Save and test">
          Click <strong>Save</strong>, then <strong>Test</strong>. The test checks that the Claude binary is runnable; when an API key is saved, it also validates the key against Anthropic.
        </Step>
      </div>
  );
}
