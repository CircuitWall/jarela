"use client";
import { User } from "lucide-react";
import { ProfileEditor } from "./ProfileEditor";

export function ProfilePanel() {
  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <User size={14} className="text-zinc-400" />
        <h2 className="text-sm font-semibold text-zinc-100">User Profile</h2>
      </div>
      <div className="flex-1 overflow-y-auto max-w-lg mx-auto w-full">
        <ProfileEditor />
      </div>
    </div>
  );
}
