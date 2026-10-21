"use client";
import { createContext, useContext, useEffect, useReducer, type ReactNode } from "react";

export type ExperienceMode = "essential" | "full";

const EXPERIENCE_MODE_KEY = "jarela.experience.mode";

// Back-compat: pre-rename builds stored "normal" / "advanced". Read those
// values silently so an upgrade does not reset the user's choice.
function parseStoredMode(raw: string | null): ExperienceMode | null {
  if (raw === "essential" || raw === "normal") return "essential";
  if (raw === "full" || raw === "advanced") return "full";
  return null;
}

export type Tab = "chat" | "dashboard" | "agents" | "memory" | "documents" | "models" | "credentials" | "mcp" | "extensions" | "tools" | "tasks" | "bridges" | "profile" | "harness" | "logs" | "env" | "settings";

export interface FirstRunChatKickoff {
  id: string;
  agentId: string;
  message: string;
}

const FIRST_RUN_KICKOFF_SESSION_KEY = "jarela:first-run-chat-kickoff";

function readPendingFirstRunKickoff(): FirstRunChatKickoff | null {
  try {
    const raw = window.sessionStorage.getItem(FIRST_RUN_KICKOFF_SESSION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<FirstRunChatKickoff>;
    if (typeof value.id !== "string" || typeof value.agentId !== "string" || typeof value.message !== "string") return null;
    return { id: value.id, agentId: value.agentId, message: value.message };
  } catch {
    return null;
  }
}

export function persistFirstRunChatKickoff(kickoff: FirstRunChatKickoff): void {
  try {
    window.sessionStorage.setItem(FIRST_RUN_KICKOFF_SESSION_KEY, JSON.stringify(kickoff));
  } catch {
    // The current in-memory flow still works if session storage is unavailable.
  }
}

export function clearFirstRunChatKickoff(): void {
  try {
    window.sessionStorage.removeItem(FIRST_RUN_KICKOFF_SESSION_KEY);
  } catch {
    // Nothing else to clear when storage is unavailable.
  }
}

interface AppState {
  activeThreadId: string | null;
  activeAgentId: string | null;
  activeTab: Tab;
  experienceMode: ExperienceMode;
  firstRunChatKickoff: FirstRunChatKickoff | null;
  // Per-tab sub-selection (a sub-tab key under credentials, an mcp server name, an
  // agent uuid, a profile subsection slug, …). Settings panels read their
  // slot to scroll-to + highlight; the URL mirrors this via `?item=<id>`.
  selectedItem: Partial<Record<Tab, string>>;
}

type Action =
  | { type: "SELECT_THREAD"; threadId: string; agentId: string }
  | { type: "NEW_CHAT" }
  | { type: "SET_AGENT"; agentId: string }
  | { type: "SET_TAB"; tab: Tab }
  | { type: "SET_EXPERIENCE_MODE"; mode: ExperienceMode }
  | { type: "SET_FIRST_RUN_CHAT_KICKOFF"; kickoff: FirstRunChatKickoff | null }
  | { type: "SET_SELECTION"; tab: Tab; itemId: string | null };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SELECT_THREAD":
      return { ...state, activeThreadId: action.threadId, activeAgentId: action.agentId, activeTab: "chat" };
    case "NEW_CHAT":
      return { ...state, activeThreadId: null, activeAgentId: null, activeTab: "chat" };
    case "SET_AGENT":
      return { ...state, activeAgentId: action.agentId };
    case "SET_TAB":
      return { ...state, activeTab: action.tab };
    case "SET_EXPERIENCE_MODE":
      return { ...state, experienceMode: action.mode };
    case "SET_FIRST_RUN_CHAT_KICKOFF":
      return { ...state, firstRunChatKickoff: action.kickoff };
    case "SET_SELECTION": {
      const next = { ...state.selectedItem };
      if (action.itemId == null) delete next[action.tab];
      else next[action.tab] = action.itemId;
      return { ...state, selectedItem: next };
    }
  }
}

const AppContext = createContext<{ state: AppState; dispatch: React.Dispatch<Action> } | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    activeThreadId: null,
    activeAgentId: null,
    activeTab: "chat",
    experienceMode: "essential",
    firstRunChatKickoff: null,
    selectedItem: {},
  });

  useEffect(() => {
    const pendingKickoff = readPendingFirstRunKickoff();
    if (pendingKickoff) dispatch({ type: "SET_FIRST_RUN_CHAT_KICKOFF", kickoff: pendingKickoff });
    try {
      const stored = parseStoredMode(window.localStorage.getItem(EXPERIENCE_MODE_KEY));
      if (stored) {
        dispatch({ type: "SET_EXPERIENCE_MODE", mode: stored });
      }
    } catch {
      // ignore storage failures
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(EXPERIENCE_MODE_KEY, state.experienceMode);
    } catch {
      // ignore storage failures
    }
  }, [state.experienceMode]);

  return <AppContext.Provider value={{ state, dispatch }}>{children}</AppContext.Provider>;
}

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppContext must be used within AppProvider");
  return ctx;
}
