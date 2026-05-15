"use client";
import { useEffect, useRef, useState } from "react";
import { Upload, Plus, Trash2, Shield } from "lucide-react";
import { api } from "@/api/client";
import type { UserProfile, AccessWhitelistEntry } from "@/api/types";

export function ProfileEditor() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [about, setAbout] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.profile.get().then((p) => {
      setProfile(p);
      setName(p.name);
      setIcon(p.icon);
      setAbout(p.about);
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
      const updated = await api.profile.update({ name, icon, about });
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
    ? name !== profile.name || icon !== profile.icon || about !== profile.about
    : false;

  return (
    <div className="p-4 space-y-4">
      {/* Icon + name row */}
      <div className="flex items-end gap-3">
        <div className="shrink-0">
          <span className="text-xs text-zinc-400 mb-1 block">Icon</span>
          <button
            onClick={() => fileRef.current?.click()}
            className="w-14 h-14 rounded-xl border-2 border-dashed border-border bg-surface-3 flex items-center justify-center hover:border-accent transition-colors overflow-hidden group"
            title="Upload avatar"
          >
            {icon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={icon} alt="avatar" className="w-full h-full object-cover" />
            ) : (
              <Upload size={14} className="text-zinc-500 group-hover:text-accent transition-colors" />
            )}
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleIconFile} />
          {icon && (
            <button onClick={() => setIcon(null)} className="text-[10px] text-zinc-500 hover:text-red-400 mt-0.5 block">
              Remove
            </button>
          )}
        </div>
        <label className="flex-1 block">
          <span className="text-xs text-zinc-400 mb-1 block">Name</span>
          <input
            className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
          />
        </label>
      </div>

      {/* About */}
      <label className="block">
        <span className="text-xs text-zinc-400 mb-1 block">About me</span>
        <textarea
          className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent h-28 resize-none"
          value={about}
          onChange={(e) => setAbout(e.target.value)}
          placeholder="Senior engineer at Acme Corp. Prefers concise answers. Working on a payments platform…"
        />
      </label>

      <p className="text-[11px] text-zinc-600">
        This information is appended to every agent&apos;s context so they know who they&apos;re talking to.
      </p>

      <button
        onClick={handleSave}
        disabled={saving || !isDirty}
        className="w-full py-1.5 text-sm bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-40"
      >
        {saving ? "Saving…" : saved ? "Saved" : "Save profile"}
      </button>

      <AccessWhitelist />
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
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
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
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    setError(null);
    setBusy(true);
    try { await api.access.remove(id); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="pt-4 border-t border-border space-y-2">
      <div className="flex items-center gap-2">
        <Shield size={14} className="text-zinc-400" />
        <h3 className="text-sm font-semibold text-zinc-100">Tailscale access whitelist</h3>
      </div>
      <p className="text-[11px] text-zinc-500">
        Identities allowed to reach LangGUI through <code className="text-zinc-400">tailscale serve</code>.
        Local access (<code className="text-zinc-400">localhost</code>) is always allowed.
        Tailscale passes the identity via the <code className="text-zinc-400">Tailscale-User-Login</code> header.
      </p>

      <div className="flex gap-2 items-end">
        <label className="flex-1 block">
          <span className="text-[10px] text-zinc-500 mb-0.5 block">Identity (email)</span>
          <input
            className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
            placeholder="you@example.com"
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
          />
        </label>
        <label className="w-32 block">
          <span className="text-[10px] text-zinc-500 mb-0.5 block">Label (optional)</span>
          <input
            className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
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

      {error && <p className="text-red-400 text-xs">{error}</p>}

      <ul className="divide-y divide-border border border-border rounded">
        {entries === null && (
          <li className="px-3 py-2 text-xs text-zinc-500">Loading…</li>
        )}
        {entries && entries.length === 0 && (
          <li className="px-3 py-2 text-xs text-zinc-500">No remote identities allowed yet.</li>
        )}
        {entries?.map((e) => (
          <li key={e.identity} className="px-3 py-2 flex items-center gap-2 text-xs">
            <div className="flex-1 min-w-0">
              <div className="font-mono text-zinc-100 truncate">{e.identity}</div>
              <div className="text-[10px] text-zinc-500">
                {e.display_name ? `${e.display_name} · ` : ""}
                added {new Date(e.added_at).toLocaleString()}
                {e.last_seen_at ? ` · last seen ${new Date(e.last_seen_at).toLocaleString()}` : " · never seen"}
              </div>
            </div>
            <button
              onClick={() => remove(e.identity)}
              disabled={busy}
              className="p-1 text-zinc-500 hover:text-red-400 disabled:opacity-40"
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
