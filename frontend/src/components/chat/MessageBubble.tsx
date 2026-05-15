import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { Message } from "../../api/types";

interface Props {
  message: Message | { role: "assistant"; content: string; streaming?: boolean };
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === "user";
  const streaming = "streaming" in message && message.streaming;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-4`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
          isUser
            ? "bg-accent text-white rounded-br-sm"
            : "bg-surface-3 text-zinc-100 rounded-bl-sm"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code({ className, children }) {
                  const match = /language-(\w+)/.exec(className ?? "");
                  const code = String(children).replace(/\n$/, "");
                  return match ? (
                    <SyntaxHighlighter style={oneDark} language={match[1]} PreTag="div">
                      {code}
                    </SyntaxHighlighter>
                  ) : (
                    <code className="bg-surface-2 px-1 rounded text-zinc-300">{code}</code>
                  );
                },
              }}
            >
              {message.content}
            </ReactMarkdown>
            {streaming && <span className="inline-block w-2 h-4 bg-zinc-400 animate-pulse ml-0.5 align-middle" />}
          </div>
        )}
      </div>
    </div>
  );
}
