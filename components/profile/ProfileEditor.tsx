"use client";
import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { api } from "@/api/client";
import type { UserProfile } from "@/api/types";

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
    </div>
  );
}
