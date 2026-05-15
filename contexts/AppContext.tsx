"use client";
import { createContext, useContext, useReducer, type ReactNode } from "react";

export type Tab = "chat" | "agents" | "memory" | "models" | "mcp" | "integrations" | "tasks" | "profile";

interface AppState {
  activeThreadId: string | null;
  activeAgentId: string | null;
  activeTab: Tab;
}

type Action =
  | { type: "SELECT_THREAD"; threadId: string; agentId: string }
  | { type: "NEW_CHAT" }
  | { type: "SET_AGENT"; agentId: string }
  | { type: "SET_TAB"; tab: Tab };

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
  }
}

const AppContext = createContext<{ state: AppState; dispatch: React.Dispatch<Action> } | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { activeThreadId: null, activeAgentId: null, activeTab: "chat" });
  return <AppContext.Provider value={{ state, dispatch }}>{children}</AppContext.Provider>;
}

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppContext must be used within AppProvider");
  return ctx;
}
