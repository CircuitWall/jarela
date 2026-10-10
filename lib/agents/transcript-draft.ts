import type { StreamChunk } from "@/lib/agents/base";
import { stripDeclaredReferencesFence } from "@/api/message-content";
import {
  addMessage,
  appendMessageDraft,
  appendMessageDraftToolEvent,
  capToolEventPayload,
  replaceMessageDraft,
  type PersistedToolEvent,
} from "@/lib/stores/threads";

export interface AssistantTranscriptDraft {
  msg_id: string;
  seq: number;
  rawContent: string;
  visibleContent: string;
  eventIndex: number;
}

export function createAssistantTranscriptDraft(threadId: string): AssistantTranscriptDraft {
  const row = addMessage(threadId, "assistant", "", null, null, null, "in_progress");
  return { msg_id: row.msg_id, seq: row.seq, rawContent: "", visibleContent: "", eventIndex: 0 };
}

export function persistAssistantDraftChunk(draft: AssistantTranscriptDraft, chunk: StreamChunk): void {
  if (chunk.type === "text_delta" && typeof chunk.data.delta === "string") {
    draft.rawContent += chunk.data.delta;
    const nextVisible = stripDeclaredReferencesFence(draft.rawContent);
    if (nextVisible.startsWith(draft.visibleContent)) {
      appendMessageDraft(draft.msg_id, nextVisible.slice(draft.visibleContent.length));
    } else {
      replaceMessageDraft(draft.msg_id, nextVisible);
    }
    draft.visibleContent = nextVisible;
    return;
  }

  if (chunk.type === "reset_text") {
    draft.rawContent = "";
    draft.visibleContent = "";
    replaceMessageDraft(draft.msg_id, "");
    return;
  }

  if (chunk.type !== "tool_call" && chunk.type !== "tool_result") return;
  const data = chunk.data as Record<string, unknown>;
  const event: PersistedToolEvent = chunk.type === "tool_call"
    ? {
        id: typeof data.id === "string" ? data.id : `call-${draft.eventIndex}`,
        phase: "call",
        name: typeof data.name === "string" ? data.name : "",
        payload: data.arguments,
      }
    : {
        id: typeof data.id === "string" ? data.id : `result-${draft.eventIndex}`,
        phase: "result",
        name: typeof data.name === "string" ? data.name : "",
        payload: data.result,
      };
  appendMessageDraftToolEvent(draft.msg_id, capToolEventPayload(event));
  draft.eventIndex++;
}