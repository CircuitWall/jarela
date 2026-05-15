import { useCallback, useRef, useState } from "react";
import { streamChat } from "../api/client";
import type { SSEEventType } from "../api/types";

export interface StreamState {
  streaming: boolean;
  streamingContent: string;
  error: string | null;
}

export function useSSE(onDone?: () => void) {
  const [state, setState] = useState<StreamState>({
    streaming: false,
    streamingContent: "",
    error: null,
  });
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(
    async (threadId: string, message: string) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setState({ streaming: true, streamingContent: "", error: null });

      try {
        for await (const raw of streamChat(threadId, message, ctrl.signal)) {
          const event = JSON.parse(raw) as SSEEventType;
          if (event.type === "text_delta") {
            setState((prev) => ({
              ...prev,
              streamingContent: prev.streamingContent + event.delta,
            }));
          } else if (event.type === "done") {
            setState({ streaming: false, streamingContent: "", error: null });
            onDone?.();
            break;
          } else if (event.type === "error") {
            setState({ streaming: false, streamingContent: "", error: event.message });
            break;
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setState({ streaming: false, streamingContent: "", error: String(err) });
        } else {
          setState({ streaming: false, streamingContent: "", error: null });
        }
      }
    },
    [onDone]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { ...state, start, stop };
}
