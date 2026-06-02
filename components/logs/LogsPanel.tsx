"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Download, Filter, Pause, Play, Search, Trash2 } from "lucide-react";

interface LogEntry {
  seq: number;
  ts: number;
  level: "log" | "info" | "warn" | "error";
  text: string;
}

const LEVEL_LABEL: Record<LogEntry["level"], string> = {
  log: "log",
  info: "info",
  warn: "warn",
  error: "error",
};

const LEVEL_BG: Record<LogEntry["level"], string> = {
  log: "bg-fg-faint/15",
  info: "bg-sky-500/15",
  warn: "bg-amber-500/20",
  error: "bg-rose-500/25",
};

const LEVEL_FG: Record<LogEntry["level"], string> = {
  log: "text-fg-faint",
  info: "text-sky-700 dark:text-sky-300",
  warn: "text-amber-700 dark:text-amber-300",
  error: "text-rose-700 dark:text-rose-300",
};

// Display cap. The server ring is 2000; we keep the same on the client so
// scrollback stays bounded across long sessions even if the server ring
// is bigger via env override.
const CLIENT_RING_CAP = 2000;

const DEFAULT_LEVELS: ReadonlySet<LogEntry["level"]> = new Set(["log", "info", "warn", "error"]);

/**
 * Live server-log panel. Subscribes to /api/v1/logs (SSE), renders a
 * scrollback with level filters + free-text grep + autoscroll toggle +
 * export-to-clipboard.
 *
 * Reconnects via EventSource auto-retry. Passes `?since=<seq>` on
 * reconnect so the server replays only what we missed since the last
 * seen entry — no duplicates across drops.
 */
export function LogsPanel() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [autoscroll, setAutoscroll] = useState(true);
  const [search, setSearch] = useState("");
  const [levels, setLevels] = useState<Set<LogEntry["level"]>>(new Set(DEFAULT_LEVELS));
  const [connected, setConnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastSeqRef = useRef<number>(0);

  // Track lastSeq via ref so the EventSource handler doesn't re-bind on
  // every entry update. Same pattern as useSSE in the chat hook.
  useEffect(() => {
    if (entries.length > 0) lastSeqRef.current = entries[entries.length - 1].seq;
  }, [entries]);

  // Open the SSE feed once on mount; close on unmount. EventSource handles
  // reconnect natively — we just have to re-subscribe to events on each
  // reconnect (the stream is server-driven), and pass `?since=` on the
  // initial open so the backlog reflects what we've already seen.
  useEffect(() => {
    if (paused) return;
    const since = lastSeqRef.current;
    const url = `/api/v1/logs${since > 0 ? `?since=${since}` : ""}`;
    const es = new EventSource(url);
    let alive = true;

    es.onopen = () => { if (alive) setConnected(true); };
    es.onerror = () => { if (alive) setConnected(false); /* EventSource auto-retries */ };
    es.onmessage = (ev) => {
      let parsed: LogEntry | null = null;
      try { parsed = JSON.parse(ev.data) as LogEntry; } catch { return; }
      if (!parsed || typeof parsed.seq !== "number") return;
      setEntries((prev) => {
        // Drop dupes (same seq could arrive on reconnect if the server
        // replayed it before we updated lastSeq).
        if (prev.length > 0 && prev[prev.length - 1].seq >= parsed.seq) return prev;
        const next = prev.length >= CLIENT_RING_CAP ? prev.slice(prev.length - CLIENT_RING_CAP + 1) : prev;
        return [...next, parsed];
      });
    };

    return () => {
      alive = false;
      es.close();
      setConnected(false);
    };
  }, [paused]);

  // Autoscroll only when the user hasn't manually scrolled away from the
  // bottom. We piggy-back on the autoscroll toggle — when it's on, every
  // new entry pins the scroll to the bottom; when off, the user can read
  // arbitrary backlog without being yanked down.
  useEffect(() => {
    if (!autoscroll) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries, autoscroll]);

  // Pre-filter once per render.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (!levels.has(e.level)) return false;
      if (q && !e.text.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, search, levels]);

  function toggleLevel(level: LogEntry["level"]): void {
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      // Don't allow zero levels — that would render an empty panel and
      // confuse "is the feed broken or did I filter everything out?"
      if (next.size === 0) return prev;
      return next;
    });
  }

  function copyAll(): void {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    const text = filtered
      .map((e) => `[${new Date(e.ts).toISOString()}] ${e.level.toUpperCase()} ${e.text}`)
      .join("\n");
    void navigator.clipboard.writeText(text).catch(() => {});
  }

  function clearLocal(): void {
    setEntries([]);
    lastSeqRef.current = 0;
  }

  return (
    <div className="flex flex-col h-full min-h-0 p-4">
      <div className="mb-2 flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-medium text-fg">Server logs</h2>
        <span
          className={`text-[10px] uppercase tracking-wider ${connected ? "text-emerald-600 dark:text-emerald-400" : "text-fg-faint"}`}
          title={connected ? "Streaming live from /api/v1/logs" : "Disconnected — EventSource will auto-reconnect"}
        >
          {connected ? "● live" : paused ? "⏸ paused" : "○ connecting…"}
        </span>
        <span className="text-[10px] text-fg-faint">
          {filtered.length} / {entries.length} entries
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          {(Object.keys(LEVEL_LABEL) as LogEntry["level"][]).map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => toggleLevel(level)}
              className={`px-2 py-0.5 rounded text-[11px] uppercase tracking-wider border ${
                levels.has(level)
                  ? `${LEVEL_BG[level]} ${LEVEL_FG[level]} border-transparent`
                  : "border-border text-fg-faint hover:bg-surface-2"
              }`}
              title={`Toggle ${level} entries`}
            >
              {LEVEL_LABEL[level]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-[11px]">
          <Filter size={12} className="text-fg-faint" aria-hidden />
          <input
            type="text"
            placeholder="grep…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="px-2 py-0.5 rounded border border-border bg-surface text-fg w-32 text-[11px]"
          />
        </div>
        <button
          type="button"
          onClick={() => setAutoscroll((v) => !v)}
          className={`p-1 rounded border border-border ${autoscroll ? "bg-accent/20 text-accent" : "text-fg-faint"}`}
          title={autoscroll ? "Autoscroll on — new entries pin to bottom" : "Autoscroll off — scroll manually"}
        >
          <ChevronDown size={14} />
        </button>
        <button
          type="button"
          onClick={() => setPaused((v) => !v)}
          className="p-1 rounded border border-border text-fg-faint hover:bg-surface-2"
          title={paused ? "Resume streaming" : "Pause streaming"}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </button>
        <button
          type="button"
          onClick={copyAll}
          className="p-1 rounded border border-border text-fg-faint hover:bg-surface-2"
          title="Copy filtered entries to clipboard"
        >
          <Download size={14} />
        </button>
        <button
          type="button"
          onClick={clearLocal}
          className="p-1 rounded border border-border text-fg-faint hover:bg-surface-2"
          title="Clear locally (server ring keeps the entries)"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div
        ref={scrollRef}
        className="panel-scrollbar flex-1 min-h-0 overflow-y-auto rounded-md border border-border bg-surface font-mono text-[11px]"
      >
        {filtered.length === 0 ? (
          <div className="p-4 text-center text-fg-faint flex flex-col items-center gap-2">
            <Search size={20} aria-hidden />
            <div>{entries.length === 0 ? "Waiting for log entries…" : "No entries match the current filter."}</div>
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {filtered.map((e) => (
              <li
                key={e.seq}
                className={`px-2 py-1 flex gap-2 items-start hover:bg-surface-2/40 ${LEVEL_FG[e.level]}`}
              >
                <span className="shrink-0 text-fg-faint w-[8.5em] tabular-nums">
                  {new Date(e.ts).toISOString().replace("T", " ").slice(11, 23)}
                </span>
                <span className={`shrink-0 px-1.5 rounded text-[10px] uppercase tracking-wider ${LEVEL_BG[e.level]}`}>
                  {LEVEL_LABEL[e.level]}
                </span>
                <span className="flex-1 whitespace-pre-wrap break-all">{e.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
