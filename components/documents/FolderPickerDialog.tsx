"use client";
import { ArrowUp, Check, Folder, FolderOpen, Home, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { api } from "@/api/client";
import { errorMessage } from "@/lib/utils/error";

interface Props {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

// FolderPickerDialog — modal browser over the local filesystem via
// /api/v1/fs/browse. Used by DocumentsPanel to add an indexed folder
// without making the user type an absolute path. Hidden dotfiles are
// filtered server-side; users can paste a path into the text input
// at the top to jump anywhere they have read access to.
export function FolderPickerDialog({ initialPath, onSelect, onClose }: Props) {
  const [cwd, setCwd] = useState<string>(initialPath ?? "");
  const [parent, setParent] = useState<string | null>(null);
  const [home, setHome] = useState<string>("");
  const [entries, setEntries] = useState<{ name: string; path: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState<string>(initialPath ?? "");

  const navigate = useCallback(async (target?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.fs.browse(target);
      setCwd(res.path);
      setParent(res.parent);
      setHome(res.home);
      setEntries(res.entries);
      setPathInput(res.path);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void navigate(initialPath); }, [initialPath, navigate]);

  useEscapeKey(onClose);

  function jumpToPath(e: React.FormEvent) {
    e.preventDefault();
    if (!pathInput.trim()) return;
    void navigate(pathInput.trim());
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-surface-2 border border-border rounded-2xl w-full max-w-lg shadow-xl flex flex-col" style={{ maxHeight: "80vh" }}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-fg flex items-center gap-2">
            <FolderOpen size={14} /> Pick a folder
          </h3>
          <button onClick={onClose} className="text-fg-subtle hover:text-fg transition-colors"><X size={16} /></button>
        </div>

        <div className="px-4 py-3 border-b border-border space-y-2">
          <form onSubmit={jumpToPath} className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void navigate(home)}
              title="Go to home"
              className="p-1.5 rounded-md text-fg-subtle hover:text-fg hover:bg-surface-3"
            >
              <Home size={14} />
            </button>
            <button
              type="button"
              onClick={() => parent && void navigate(parent)}
              disabled={!parent}
              title="Go up"
              className="p-1.5 rounded-md text-fg-subtle hover:text-fg hover:bg-surface-3 disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ArrowUp size={14} />
            </button>
            <input
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              className="flex-1 min-w-0 px-2 py-1 rounded-md bg-surface-3 border border-border text-xs text-fg font-mono focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </form>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-1.5">
          {loading && (
            <p className="text-fg-faint text-sm py-6 text-center">Loading…</p>
          )}
          {!loading && error && (
            <p className="text-red-600 dark:text-red-400 text-xs px-2 py-3">{error}</p>
          )}
          {!loading && !error && entries.length === 0 && (
            <p className="text-fg-faint text-xs italic px-2 py-3">No subfolders here.</p>
          )}
          {!loading && !error && entries.map((e) => (
            <button
              key={e.path}
              type="button"
              onDoubleClick={() => void navigate(e.path)}
              onClick={() => void navigate(e.path)}
              className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left text-xs text-fg hover:bg-surface-3"
              title={e.path}
            >
              <Folder size={13} className="text-accent shrink-0" />
              <span className="truncate">{e.name}</span>
            </button>
          ))}
        </div>

        <div className="flex justify-between items-center gap-2 px-4 py-3 border-t border-border">
          <span className="text-[11px] text-fg-faint font-mono truncate flex-1" title={cwd}>{cwd}</span>
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-fg-subtle hover:text-fg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSelect(cwd)}
            disabled={!cwd || loading}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-50"
          >
            <Check size={13} /> Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}
