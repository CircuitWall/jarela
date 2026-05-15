import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import type { Message } from "../../api/types";
import { useSSE } from "../../hooks/useSSE";
import { AgentSelector } from "./AgentSelector";
import { InputBar } from "./InputBar";
import { MessageList } from "./MessageList";

interface Props {
  threadId: string | null;
  agentId: string | null;
  onAgentChange: (agentId: string) => void;
  onThreadCreated: (threadId: string, agentId: string) => void;
  onMessageSent: () => void;
}

export function ChatView({ threadId, agentId, onAgentChange, onThreadCreated, onMessageSent }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");

  const handleDone = useCallback(() => {
    if (threadId) {
      api.threads.get(threadId).then((d) => setMessages(d.messages));
      onMessageSent();
    }
  }, [threadId, onMessageSent]);

  const { streaming, streamingContent, error, start, stop } = useSSE(handleDone);

  useEffect(() => {
    if (!threadId) {
      setMessages([]);
      return;
    }
    api.threads.get(threadId).then((d) => setMessages(d.messages)).catch(console.error);
  }, [threadId]);

  async function handleSubmit() {
    const msg = input.trim();
    if (!msg || !agentId) return;
    setInput("");

    let activeThreadId = threadId;
    if (!activeThreadId) {
      const thread = await api.threads.create(agentId);
      activeThreadId = thread.thread_id;
      onThreadCreated(thread.thread_id, agentId);
    }

    // Optimistically add user message
    const optimistic: Message = {
      id: `opt-${Date.now()}`,
      role: "user",
      content: msg,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);

    await start(activeThreadId, msg);
  }

  const agentLocked = messages.length > 0;

  return (
    <div className="flex flex-col h-full">
      <AgentSelector value={agentId} onChange={onAgentChange} disabled={agentLocked} />
      <MessageList messages={messages} streamingContent={streaming ? streamingContent : undefined} />
      {error && (
        <div className="mx-4 mb-2 px-3 py-2 rounded bg-red-900/40 border border-red-700 text-red-300 text-xs">
          {error}
        </div>
      )}
      <InputBar
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        onStop={stop}
        streaming={streaming}
        disabled={!agentId}
      />
    </div>
  );
}
