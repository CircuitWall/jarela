"use client";
import { Copy, Lock, Plus } from "lucide-react";
import type { Skill } from "@/api/types";

interface Props {
  skills: Skill[];
  loading: boolean;
  canWrite: boolean;
  onNew: () => void;
  onEdit: (id: string) => void;
  onClone: (id: string) => void;
}

export function SkillList({ skills, loading, canWrite, onNew, onEdit, onClone }: Props) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Skills</label>
        <button
          onClick={onNew}
          disabled={!canWrite}
          title={canWrite ? "Write a new skill" : "Add a skill repo first"}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus size={13} /> New
        </button>
      </div>

      {loading && skills.length === 0 && (
        <p className="text-fg-faint text-sm py-3 text-center">Loading…</p>
      )}
      {!loading && skills.length === 0 && (
        <p className="text-fg-faint text-xs italic">No skills yet.</p>
      )}

      {skills.map((s) => {
        const isBuiltin = s.source === "builtin";
        return (
          <div
            key={s.id}
            onClick={() => { if (!isBuiltin) onEdit(s.id); }}
            className={`flex items-center gap-3 py-2.5 border-b border-border/60 group${!isBuiltin ? " cursor-pointer hover:bg-surface-3/30 transition-colors" : ""}`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-sm font-medium text-fg truncate">{s.name}</span>
                {isBuiltin && <Lock size={10} className="text-fg-faint shrink-0" />}
              </div>
              {s.description && <p className="text-xs text-fg-subtle truncate">{s.description}</p>}
            </div>
            <div className="flex gap-1 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity shrink-0">
              {isBuiltin ? (
                <button
                  onClick={(e) => { e.stopPropagation(); onClone(s.id); }}
                  disabled={!canWrite}
                  title={canWrite ? "Clone to customize — same id overrides the built-in" : "Add a skill repo first"}
                  className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-accent hover:text-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Copy size={12} /> Clone
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}
