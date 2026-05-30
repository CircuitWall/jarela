"use client";
import { createContext, useContext, useEffect, useReducer, type ReactNode } from "react";

export type ExperienceMode = "normal" | "advanced";

const EXPERIENCE_MODE_KEY = "jarela.experience.mode";

export type Tab = "chat" | "agents" | "memory" | "documents" | "models" | "mcp" | "extensions" | "tools" | "connections" | "tasks" | "bridges" | "profile" | "harness";

interface AppState {
  activeThreadId: string | null;
  activeAgentId: string | null;
  activeTab: Tab;
  experienceMode: ExperienceMode;
  // Per-tab sub-selection (gmail in connections, an mcp server name, an
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
    experienceMode: "advanced",
    selectedItem: {},
  });

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(EXPERIENCE_MODE_KEY);
      if (stored === "normal" || stored === "advanced") {
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
