"use client";
import { useEffect, useRef, useState } from "react";
import { Upload, Plus, Trash2, Shield, MapPin, Globe, Check, Copy } from "lucide-react";
import { api } from "@/api/client";
import type { UserProfile, AccessWhitelistEntry, TailscaleStatus } from "@/api/types";
import { useLocationSharing } from "@/hooks/useLocationSharing";
import { useAppContext } from "@/contexts/AppContext";
import { formatRelative } from "@/lib/utils/time";
import { MarkdownTextarea } from "@/components/ui/MarkdownTextarea";
import { errorMessage } from "@/lib/utils/error";

export function ProfileEditor() {
  const { state, dispatch } = useAppContext();
  const mode = state.experienceMode;
  const fileRef = useRef<HTMLInputElement>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [about, setAbout] = useState("");
  const [preset, setPreset] = useState<UserProfile["preset"]>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.profile.get().then((p) => {
      setProfile(p);
      setName(p.name);
      setIcon(p.icon);
      setAbout(p.about);
      setPreset(p.preset ?? null);
    }).catch(console.error);
  }, []);

  function handleIconFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setIcon(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      const updated = await api.profile.update({ name, icon, about, preset });
      setProfile(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  const isDirty = profile
    ? name !== profile.name
      || icon !== profile.icon
      || about !== profile.about
      || (preset ?? null) !== (profile.preset ?? null)
    : false;

  return (
    <div className="p-4 space-y-4">
      {/* Icon + name row */}
      <div className="flex items-end gap-3">
        <div className="shrink-0">
          <span className="text-xs text-fg-subtle mb-1 block">Icon</span>
          <button
            onClick={() => fileRef.current?.click()}
            className="w-14 h-14 rounded-xl border-2 border-dashed border-border bg-surface-3 flex items-center justify-center hover:border-accent transition-colors overflow-hidden group"
            title="Upload avatar"
          >
            {icon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={icon} alt="avatar" className="w-full h-full object-cover" />
            ) : (
              <Upload size={14} className="text-fg-faint group-hover:text-accent transition-colors" />
            )}
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleIconFile} />
          {icon && (
            <button onClick={() => setIcon(null)} className="text-[10px] text-fg-faint hover:text-red-700 dark:hover:text-red-400 mt-0.5 block">
              Remove
            </button>
          )}
        </div>
        <label className="flex-1 block">
          <span className="text-xs text-fg-subtle mb-1 block">Name</span>
          <input
            className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
          />
        </label>
      </div>

      {/* About */}
      <label className="block">
        <span className="text-xs text-fg-subtle mb-1 block">About me</span>
        <MarkdownTextarea
          className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent min-h-[7rem] resize-y"
          value={about}
          onChange={setAbout}
          rows={5}
          placeholder="Senior engineer at Acme Corp. Prefers concise answers. Working on a payments platformâ€¦"
        />
      </label>

      <p className="text-[11px] text-fg-faint">
        This information is appended to every agent&apos;s context so they know who they&apos;re talking to.
      </p>

      <PresetPicker value={preset} onChange={setPreset} />

      <div className="pt-4 border-t border-border">
        <div className="rounded-xl border border-border bg-surface-1/40 p-3 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-fg">Experience mode</h3>
          <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border border-border bg-surface-3 text-fg-faint">
            {mode}
          </span>
        </div>
        <p className="text-[11px] text-fg-faint leading-snug">
          Choose how much configuration detail is shown in the app.
          Essential hides technical panels and advanced model controls.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => dispatch({ type: "SET_EXPERIENCE_MODE", mode: "essential" })}
            aria-pressed={mode === "essential"}
            className={`text-left px-3 py-2.5 rounded-xl border transition-colors ${
              mode === "essential"
                ? "border-accent/60 bg-accent/15 text-fg shadow-sm"
                : "border-border bg-surface-3 text-fg-muted hover:text-fg hover:border-border-strong"
            }`}
          >
            <div className="text-xs font-medium">Essential</div>
            <div className="text-[10px] text-fg-faint leading-tight mt-0.5">Cleaner layout, fewer technical controls</div>
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: "SET_EXPERIENCE_MODE", mode: "full" })}
            aria-pressed={mode === "full"}
            className={`text-left px-3 py-2.5 rounded-xl border transition-colors ${
              mode === "full"
                ? "border-accent/60 bg-accent/15 text-fg shadow-sm"
                : "border-border bg-surface-3 text-fg-muted hover:text-fg hover:border-border-strong"
            }`}
          >
            <div className="text-xs font-medium">Full</div>
            <div className="text-[10px] text-fg-faint leading-tight mt-0.5">Per-function controls and full tuning</div>
          </button>
        </div>
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving || !isDirty}
        className="w-full py-2 text-sm font-medium bg-accent hover:bg-accent-hover text-white rounded-xl shadow-sm transition-colors disabled:opacity-40"
      >
        {saving ? "Savingâ€¦" : saved ? "Saved" : "Save profile"}
      </button>

      <LocationSharing profile={profile} onChange={setProfile} />

      <TailscaleServe />

      <AccessWhitelist />
    </div>
  );
}

// ─── Persona preset ──────────────────────────────────────────────────────
// Drives the Credentials panel's category filter. Strictly a UX shortcut:
// each preset just hides categories that aren't useful for the chosen
// persona. "Everything" (== custom in the DB) means no filtering — same as
// having no preset at all, which is what fresh installs get.
//
// Storing the literal string keeps the column trivially extensible: a
// future "education" preset is a one-line tweak to PRESET_CATEGORIES.

type Preset = NonNullable<UserProfile["preset"]>;

const PRESET_OPTIONS: Array<{ value: Preset; label: string; hint: string }> = [
  { value: "home",   label: "Home",      hint: "LLMs, mail, calendar, chat" },
  { value: "work",   label: "Work",      hint: "Office toolbelt + issue trackers" },
  { value: "dev",    label: "Developer", hint: "Everything, incl. infrastructure" },
  { value: "custom", label: "Everything", hint: "No filter — show every integration" },
];

function PresetPicker({
  value,
  onChange,
}: {
  value: UserProfile["preset"];
  onChange: (v: Preset) => void;
}) {
  return (
    <div className="block">
      <span className="text-xs text-fg-subtle mb-1 block">Persona</span>
      <p className="text-[11px] text-fg-faint mb-2">
        Filters the Credentials list so you only see integrations relevant
        to how you use Jarela. Pick &quot;Everything&quot; to see them all.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {PRESET_OPTIONS.map((o) => {
          const selected = (value ?? "custom") === o.value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(o.value)}
              aria-pressed={selected}
              className={`text-left px-3 py-2.5 rounded-xl border transition-colors ${
                selected
                  ? "border-accent/60 bg-accent/15 text-fg shadow-sm"
                  : "border-border bg-surface-3 text-fg-muted hover:text-fg hover:border-border-strong"
              }`}
            >
              <div className="text-xs font-medium">{o.label}</div>
              <div className="text-[10px] text-fg-faint leading-tight mt-0.5">{o.hint}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// â”€â”€â”€ Location sharing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// User-facing toggle backed by user_profile.location_consent. When enabled,
// the useLocationSharing hook acquires a browser geolocation fix and POSTs
// it to /api/v1/profile/location. The agent sees the latest position in
// every system prompt and can also call the get_user_location tool.

function LocationSharing({
  profile,
  onChange,
}: {
  profile: UserProfile | null;
  onChange: (p: UserProfile) => void;
}) {
  const consent = profile?.location_consent === 1;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Drives the browser geolocation request + watcher whenever consent is on.
  useLocationSharing(consent);

  // Pick up server-side updates (timestamps, accuracy) after the hook POSTs.
  useEffect(() => {
    if (!consent) return;
    const t = setInterval(() => {
      api.profile.get().then(onChange).catch(() => { /* ignore */ });
    }, 5000);
    return () => clearInterval(t);
  }, [consent, onChange]);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!consent && typeof navigator !== "undefined" && !navigator.geolocation) {
        throw new Error("Geolocation is not supported in this browser.");
      }
      const updated = await api.profile.setLocationConsent(!consent);
      onChange(updated);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const hasFix = consent && typeof profile?.location_lat === "number" && typeof profile?.location_lng === "number";
  const updatedAt = profile?.location_updated_at;

  return (
    <div className="pt-4 border-t border-border space-y-2">
      <div className="flex items-center gap-2">
        <MapPin size={14} className="text-fg-subtle" />
        <h3 className="text-sm font-semibold text-fg mr-auto">Share my location</h3>
        <button
          onClick={toggle}
          disabled={busy}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            consent ? "bg-accent" : "bg-surface-3 border border-border"
          } disabled:opacity-40`}
          title={consent ? "Stop sharing" : "Start sharing"}
          aria-pressed={consent}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              consent ? "translate-x-5" : "translate-x-1"
            }`}
          />
        </button>
      </div>
      <p className="text-[11px] text-fg-faint">
        When enabled, your browser sends your current coordinates to Jarela so the agent can answer
        location-aware questions (weather, nearby places, directions). Stored locally only; never sent
        to any third party other than the LLM/MCP services you&apos;ve configured.
      </p>

      {consent && (
        <div className="text-[11px] text-fg-subtle px-2 py-1.5 rounded bg-surface-3/40 border border-border">
          {hasFix ? (
            <>
              <span className="font-mono">
                {profile!.location_lat!.toFixed(5)}, {profile!.location_lng!.toFixed(5)}
              </span>
              {profile?.location_accuracy_m != null && (
                <span className="text-fg-faint"> · ±{Math.round(profile.location_accuracy_m)}m</span>
              )}
              {updatedAt && (
                <span className="text-fg-faint"> · {formatRelative(updatedAt)}</span>
              )}
            </>
          ) : (
            <span className="text-fg-faint">Waiting for browser fixâ€¦ (allow location when prompted)</span>
          )}
        </div>
      )}

      {error && <p className="text-rose-700 dark:text-rose-400 text-[11px]">{error}</p>}
    </div>
  );
}

function AccessWhitelist() {
  const [entries, setEntries] = useState<AccessWhitelistEntry[] | null>(null);
  const [identity, setIdentity] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try { setEntries(await api.access.list()); }
    catch (e) { setError(errorMessage(e)); }
  }
  useEffect(() => { void refresh(); }, []);

  async function add() {
    setError(null);
    if (!identity.trim()) return;
    setBusy(true);
    try {
      await api.access.add(identity.trim(), displayName.trim() || null);
      setIdentity(""); setDisplayName("");
      await refresh();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    setError(null);
    setBusy(true);
    try { await api.access.remove(id); await refresh(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="pt-4 border-t border-border space-y-2">
      <div className="flex items-center gap-2">
        <Shield size={14} className="text-fg-subtle" />
        <h3 className="text-sm font-semibold text-fg">Tailscale access whitelist</h3>
      </div>
      <p className="text-[11px] text-fg-faint">
        Identities allowed to reach Jarela through <code className="text-fg-subtle">tailscale serve</code>.
        Local access (<code className="text-fg-subtle">localhost</code>) is always allowed.
        Tailscale passes the identity via the <code className="text-fg-subtle">Tailscale-User-Login</code> header.
      </p>

      <div className="flex gap-2 items-end">
        <label className="flex-1 block">
          <span className="text-[10px] text-fg-faint mb-0.5 block">Identity (email)</span>
          <input
            className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
            placeholder="you@example.com"
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
          />
        </label>
        <label className="w-32 block">
          <span className="text-[10px] text-fg-faint mb-0.5 block">Label (optional)</span>
          <input
            className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="iPhone"
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
          />
        </label>
        <button
          onClick={add}
          disabled={busy || !identity.trim()}
          className="px-3 py-1.5 text-xs bg-accent hover:bg-accent-hover text-white rounded transition-colors disabled:opacity-40 flex items-center gap-1"
        >
          <Plus size={12} /> Add
        </button>
      </div>

      {error && <p className="text-red-700 dark:text-red-400 text-xs">{error}</p>}

      <ul className="divide-y divide-border border border-border rounded">
        {entries === null && (
          <li className="px-3 py-2 text-xs text-fg-faint">Loadingâ€¦</li>
        )}
        {entries && entries.length === 0 && (
          <li className="px-3 py-2 text-xs text-fg-faint">No remote identities allowed yet.</li>
        )}
        {entries?.map((e) => (
          <li key={e.identity} className="px-3 py-2 flex items-center gap-2 text-xs">
            <div className="flex-1 min-w-0">
              <div className="font-mono text-fg truncate">{e.identity}</div>
              <div className="text-[10px] text-fg-faint">
                {e.display_name ? `${e.display_name} · ` : ""}
                added {new Date(e.added_at).toLocaleString()}
                {e.last_seen_at ? ` · last seen ${new Date(e.last_seen_at).toLocaleString()}` : " · never seen"}
              </div>
            </div>
            <button
              onClick={() => remove(e.identity)}
              disabled={busy}
              className="p-1 text-fg-faint hover:text-red-700 dark:hover:text-red-400 disabled:opacity-40"
              title="Remove"
            >
              <Trash2 size={12} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// â”€â”€â”€ Tailscale serve status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Companion to the access whitelist: surfaces whether `tailscale serve` is
// currently forwarding to this node, the tailnet FQDN, and a one-click
// copy of the configuration recipe. See ADR-0008 for the recipe rationale.

function TailscaleServe() {
  const [status, setStatus] = useState<TailscaleStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.tailscale.status()
      .then(setStatus)
      .catch((e) => setError(errorMessage(e)));
  }, []);

  async function copyRecipe() {
    if (!status) return;
    try {
      await navigator.clipboard.writeText(status.serve_recipe);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  }

  const reachableUrl = status?.fqdn ? `https://${status.fqdn}/` : null;

  return (
    <div className="pt-4 border-t border-border space-y-2">
      <div className="flex items-center gap-2">
        <Globe size={14} className="text-fg-subtle" />
        <h3 className="text-sm font-semibold text-fg mr-auto">Tailscale serve</h3>
        {status && (
          <span
            className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded ${
              status.serving
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                : status.installed
                ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                : "bg-surface-3 text-fg-faint"
            }`}
          >
            {!status.installed ? "not installed" : status.serving ? "serving" : status.logged_in ? "idle" : "logged out"}
          </span>
        )}
      </div>

      <p className="text-[11px] text-fg-faint">
        Expose this Jarela on your tailnet so phones (iOS PWA included) can reach it over a
        trusted HTTPS path. Run the recipe once, then add identities to the whitelist below.
      </p>

      {status?.serving && reachableUrl && (
        <div className="text-[11px] px-2 py-1.5 rounded bg-surface-3/40 border border-border">
          <span className="text-fg-faint">Reachable at </span>
          <a
            href={reachableUrl}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-accent hover:underline break-all"
          >
            {reachableUrl}
          </a>
        </div>
      )}

      {status && (
        <div className="flex items-stretch gap-1.5">
          <code className="flex-1 text-[11px] font-mono bg-surface-3 text-fg-muted px-2 py-1.5 rounded border border-border break-all leading-snug">
            {status.serve_recipe}
          </code>
          <button
            onClick={copyRecipe}
            className="px-2 text-xs bg-surface-3 hover:bg-surface text-fg-muted border border-border rounded transition-colors flex items-center gap-1"
            title="Copy recipe"
          >
            {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
          </button>
        </div>
      )}

      {status && !status.installed && (
        <p className="text-[11px] text-fg-faint">
          Tailscale isn&apos;t installed on this host. Install from{" "}
          <a href="https://tailscale.com/download/windows" target="_blank" rel="noreferrer" className="text-accent hover:underline">
            tailscale.com
          </a>{" "}
          and run <code className="text-fg-subtle">tailscale up</code> first.
        </p>
      )}

      {status?.installed && !status.logged_in && (
        <p className="text-[11px] text-fg-faint">
          Tailscale is installed but not logged in. Run <code className="text-fg-subtle">tailscale up</code> in a terminal.
        </p>
      )}

      {status && (
        <p className="text-[11px] text-fg-faint">
          Or run the helper script:{" "}
          <code className="text-fg-subtle">{status.install_script}</code>
          {" â€” "}
          <code className="text-fg-subtle">{status.uninstall_script}</code> to reverse.
        </p>
      )}

      {error && <p className="text-red-700 dark:text-red-400 text-xs">{error}</p>}
    </div>
  );
}
// â”€â”€â”€ Tailscale serve status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Companion to the access whitelist: surfaces whether `tailscale serve` is
// currently forwarding to this node, the tailnet FQDN, and a one-click
// copy of the configuration recipe. See ADR-0008 for the recipe rationale.

