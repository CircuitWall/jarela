import { useEffect, useRef } from "react";
import type { Message } from "../../api/types";
import { MessageBubble } from "./MessageBubble";

interface Props {
  messages: Message[];
  streamingContent?: string;
}

export function MessageList({ messages, streamingContent }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streamingContent]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      {messages.length === 0 && !streamingContent && (
        <div className="flex items-center justify-center h-full text-zinc-500 text-sm select-none">
          Send a message to begin
        </div>
      )}
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      {streamingContent && (
        <MessageBubble
          message={{ role: "assistant", content: streamingContent, streaming: true }}
        />
      )}
      <div ref={bottomRef} />
    </div>
  );
}
