"use client";

import { useState, type ReactNode } from "react";
import { FileText, Loader2 } from "lucide-react";
import { pushToast } from "@/lib/ui/toasts";
import { errorMessage } from "@/lib/utils/error";
import { openLocalFile } from "@/lib/ui/local-file";
import { useThreadScope } from "@/components/chat/ThreadScope";

// A reference to a file on this machine. Clicking hands it to the OS default
// app (Windows/macOS/Linux), the same action markdown file links use.
export function LocalFileAction({
  href,
  threadId,
  children,
  className,
  title,
  showIcon = true,
}: {
  href: string;
  threadId?: string | null;
  children: ReactNode;
  className?: string;
  title?: string;
  showIcon?: boolean;
}) {
  const scopeThreadId = useThreadScope();
  const [opening, setOpening] = useState(false);

  async function open() {
    if (opening) return;
    setOpening(true);
    try {
      await openLocalFile(href, threadId !== undefined ? threadId : scopeThreadId);
    } catch (error) {
      pushToast({
        kind: "error",
        source: "system",
        sourceLabel: "Files",
        title: "Could not open file",
        body: errorMessage(error),
        agent_id: null,
        thread_id: threadId !== undefined ? threadId : scopeThreadId,
        ttl: 5000,
      });
    } finally {
      setOpening(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void open()}
      disabled={opening}
      title={title ?? href}
      className={`inline-flex items-baseline gap-1 text-left underline decoration-dotted hover:decoration-solid break-all disabled:opacity-60 ${className ?? ""}`.trim()}
    >
      {showIcon && <FileText size={11} className="relative top-0.5 shrink-0" aria-hidden="true" />}
      <span>{children}</span>      {opening && <Loader2 size={10} className="relative top-0.5 shrink-0 animate-spin" aria-hidden="true" />}
    </button>
  );
}
