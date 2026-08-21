"use client";
import { BookOpen, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/api/client";
import type { Skill, SkillRepo } from "@/api/types";
import { errorMessage } from "@/lib/utils/error";
import { SkillRepoSection } from "./SkillRepoSection";
import { SkillList } from "./SkillList";
import { SkillEditor, type SkillEditState } from "./SkillEditor";

export function SkillsPanel() {
  const [repos, setRepos] = useState<SkillRepo[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SkillEditState | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [repoRes, skillRes] = await Promise.all([api.skills.repos.list(), api.skills.list()]);
      setRepos(repoRes.repos);
      setSkills(skillRes.skills);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const canWrite = repos.some((r) => r.writable && r.enabled);

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <BookOpen size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg mr-auto">Skills</h2>
        <button
          onClick={() => void load()}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors"
          title="Refresh"
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-3 space-y-5">
        <p className="text-xs text-fg-faint leading-relaxed">
          Skills are markdown playbooks agents load on demand via{" "}
          <code className="font-mono text-fg-muted">read_skill</code>. Built-in skills are read-only — add a repo
          below to write your own. When two skills share an id, a later-added repo overrides an earlier one (and
          built-ins); the repo pinned as writable is where new and edited skills are saved.
        </p>

        {error && (
          <div className="text-xs text-red-600 dark:text-red-400 px-2 py-1.5 rounded-md bg-red-500/10 border border-red-500/20">
            {error}
          </div>
        )}

        <SkillRepoSection repos={repos} onChanged={() => void load()} />

        <SkillList
          skills={skills}
          loading={loading}
          canWrite={canWrite}
          onNew={() => setEditing({ mode: "new" })}
          onEdit={(id) => setEditing({ mode: "edit", id })}
          onClone={(id) => setEditing({ mode: "clone", sourceId: id })}
        />
      </div>

      {editing && (
        <SkillEditor
          state={editing}
          onClose={() => setEditing(null)}
          onSaved={() => void load()}
        />
      )}
    </div>
  );
}
