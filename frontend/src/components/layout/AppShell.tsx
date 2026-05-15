import { useCallback } from "react";
import { useAppContext } from "../../contexts/AppContext";
import { useThreads } from "../../hooks/useThreads";
import { ChatView } from "../chat/ChatView";
import { MemoryPanel } from "../memory/MemoryPanel";
import { Sidebar } from "./Sidebar";

export function AppShell() {
  const { state, dispatch } = useAppContext();
  const { threads, createThread, deleteThread, updateThreadTitle, refresh } = useThreads();

  const handleNewThread = useCallback(() => {
    dispatch({ type: "NEW_CHAT" });
  }, [dispatch]);

  const handleDeleteThread = useCallback(
    async (id: string) => {
      await deleteThread(id);
      if (state.activeThreadId === id) dispatch({ type: "NEW_CHAT" });
    },
    [deleteThread, state.activeThreadId, dispatch]
  );

  const handleThreadCreated = useCallback(
    (threadId: string, agentId: string) => {
      dispatch({ type: "SELECT_THREAD", threadId, agentId });
      refresh();
    },
    [dispatch, refresh]
  );

  return (
    <div className="flex h-screen bg-surface text-zinc-100 overflow-hidden">
      <Sidebar
        threads={threads}
        onNewThread={handleNewThread}
        onDeleteThread={handleDeleteThread}
      />
      <main className="flex-1 flex flex-col min-w-0">
        {state.activeTab === "chat" && (
          <ChatView
            key={state.activeThreadId ?? "new"}
            threadId={state.activeThreadId}
            agentId={state.activeAgentId}
            onAgentChange={(agentId) => dispatch({ type: "SET_AGENT", agentId })}
            onThreadCreated={handleThreadCreated}
            onMessageSent={refresh}
          />
        )}
        {state.activeTab === "memory" && <MemoryPanel />}
      </main>
    </div>
  );
}
