import { z } from "zod";
import { isLoopbackRequest } from "@/lib/auth/access";
import {
  listThreadsByAgent,
  createThread,
  addMessage,
  type ThreadRow,
} from "@/lib/stores/threads";
import {
  getDefaultAgentConfig,
  listAgentConfigs,
  type AgentConfigRow,
} from "@/lib/stores/agent-configs";
import { publish } from "@/lib/notifications/bus";
import { runAgentTurn } from "@/lib/agents/agent-turn";
import type { ContentPart } from "@/lib/tools/types";
import { errorMessage } from "@/lib/utils/error";

// 100KB UTF-8 cap on captured text. The LLM context window is the real
// constraint; this cap exists to keep a runaway "<body>" pick from
// trashing the conversation. See ADR-0018.
export const MAX_TEXT_BYTES = 100_000;

// Hard cap on the inline element screenshot (base64 chars). 4 MB of
// base64 ≈ 3 MB decoded — generous for a single cropped element while
// still bounding the SQLite row and the LLM vision payload.
export const MAX_SCREENSHOT_B64 = 4_000_000;

// Preamble prepended to the LLM call for the silent observer run.
// The captured content is already persisted in the DB — this wrapper
// instructs the agent to observe without replying, matching bridge
// silent/observer mode semantics. The user can ask about the content
// in a later normal turn.
const SILENT_CAPTURE_PREAMBLE =
  "[Silent page capture — observer mode] " +
  "A web page was just captured to your context by the user's browser extension. " +
  "Silently review it. You must NOT reply with content now — the user will ask questions later. " +
  "If nothing requires immediate attention, reply with exactly the single token NO_REPLY.";

const Body = z.object({
  url: z.string().url(),
  title: z.string().max(500).optional(),
  selector: z.string().max(2000).optional(),
  tagName: z.string().max(64).optional(),
  text: z.string(),
  capturedAt: z.string().datetime(),
  // Optional base64-encoded PNG of just the picked element (no data: URL
  // prefix). The content script crops `chrome.tabs.captureVisibleTab`
  // to the element bounding box before sending. When present, it is
  // attached to the persisted user message as an image ContentPart so
  // the chat UI renders it inline and vision-capable agents can see it.
  screenshot: z.string().regex(/^[A-Za-z0-9+/=]+$/).max(MAX_SCREENSHOT_B64).optional(),
  screenshotMediaType: z.string().regex(/^image\/[a-z0-9.+-]+$/).max(64).optional(),
});

function truncateUtf8(s: string, maxBytes: number): { text: string; truncated: boolean; originalBytes: number } {
  const original = Buffer.byteLength(s, "utf8");
  if (original <= maxBytes) {
    return { text: s, truncated: false, originalBytes: original };
  }
  // Trim to byte boundary by encoding then slicing then decoding without
  // splitting a multibyte sequence. Buffer.toString("utf8") replaces an
  // incomplete trailing sequence with U+FFFD, which is acceptable here.
  const buf = Buffer.from(s, "utf8").subarray(0, maxBytes);
  return { text: buf.toString("utf8"), truncated: true, originalBytes: original };
}

// Routing rule (per user ask): the capture lands in the most recent thread
// of the *default agent* — i.e. "the last agent session" the user almost
// certainly meant. If the default agent has never been chatted with, we
// open a fresh thread under it. If there is no default agent at all
// (fresh install), fall back to the first configured agent. With zero
// agents configured we 503 — there is nowhere to put the message.
//
// Scoping to the default agent (rather than "most recent thread of any
// agent") makes routing predictable. Otherwise a stray reply on agent B
// silently retargets future captures away from the agent the user
// actually thinks of as "theirs".
interface PickResult {
  thread_id: string;
  agent_id: string;
  agent_name: string;
  thread_title: string | null;
  created: boolean;
}

function pickThread(): PickResult | { error: "no-agent" } {
  const def: AgentConfigRow | null = getDefaultAgentConfig();
  const agent: AgentConfigRow | null = def ?? listAgentConfigs()[0] ?? null;
  if (!agent) return { error: "no-agent" };

  const recent: ThreadRow[] = listThreadsByAgent(agent.id, 1);
  if (recent.length > 0) {
    return {
      thread_id: recent[0].thread_id,
      agent_id: agent.id,
      agent_name: agent.name,
      thread_title: recent[0].title,
      created: false,
    };
  }
  const t = createThread(agent.id, "Browser captures");
  return {
    thread_id: t.thread_id,
    agent_id: agent.id,
    agent_name: agent.name,
    thread_title: t.title,
    created: true,
  };
}

function composeBody(args: {
  url: string;
  title?: string;
  selector?: string;
  text: string;
  truncated: boolean;
  originalBytes: number;
  hasScreenshot?: boolean;
}): string {
  const heading = args.title
    ? `📎 Captured from [${args.title}](${args.url})`
    : `📎 Captured from <${args.url}>`;
  const lines = [heading];
  if (args.selector) lines.push(`Element: \`${args.selector}\``);
  if (args.hasScreenshot) lines.push("Screenshot attached.");
  if (args.truncated) {
    lines.push(`> ⚠ Truncated to ${MAX_TEXT_BYTES.toLocaleString()} bytes (original was ${args.originalBytes.toLocaleString()} bytes)`);
  }
  lines.push("", "---", "", args.text);
  return lines.join("\n");
}

export async function handlePageCapture(req: Request): Promise<Response> {
  if (!isLoopbackRequest(req)) {
    return new Response(JSON.stringify({ error: "loopback only" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Request body must be valid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: parsed.error.issues[0]?.message ?? "invalid body" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  const input = parsed.data;

  const picked = pickThread();
  if ("error" in picked) {
    return new Response(JSON.stringify({ error: "no agent configured" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  const { thread_id, agent_id, agent_name, thread_title, created } = picked;

  const { text, truncated, originalBytes } = truncateUtf8(input.text, MAX_TEXT_BYTES);
  const messageBody = composeBody({
    url: input.url,
    title: input.title,
    selector: input.selector,
    text,
    truncated,
    originalBytes,
    hasScreenshot: Boolean(input.screenshot),
  });

  // When a screenshot is included, persist the user turn as a multipart
  // ContentPart[] (text + image) — that's the same shape the chat UI and
  // agent runner expect for inline images, so the picture renders in the
  // bubble on reload and vision-capable models can see it on the silent
  // observer turn. Without a screenshot we keep the legacy string body
  // to avoid touching messages that never had an image.
  const screenshotPart: ContentPart | null = input.screenshot
    ? { type: "image", media_type: input.screenshotMediaType ?? "image/png", data: input.screenshot }
    : null;
  const storedContent: string = screenshotPart
    ? JSON.stringify([{ type: "text", text: messageBody }, screenshotPart] satisfies ContentPart[])
    : messageBody;

  const msg = addMessage(thread_id, "user", storedContent, undefined, "page_capture");

  // Fire a silent observer run so the agent ingests the captured context
  // without being forced to reply — matching bridge silent/observer mode.
  // The user message is already persisted above; skip_persist_user_message
  // prevents a duplicate. Fire-and-forget so the HTTP response is instant.
  void runAgentTurn({
    thread_id,
    queue_source: "extension",
    message: `${SILENT_CAPTURE_PREAMBLE}\n\n${messageBody}`,
    attachments: screenshotPart ? [screenshotPart] : undefined,
    user_category: "page_capture",
    assistant_category: "page_capture",
    silent: true,
    skip_persist_user_message: true,
  }).catch((err: unknown) => {
    const m = errorMessage(err);
    console.warn("[page-capture] silent observer run failed:", m);
  });

  publish({
    type: "thread_message_added",
    thread_id,
    agent_id,
    source: "page_capture",
    ts: Date.now(),
  });

  return new Response(
    JSON.stringify({
      thread_id,
      msg_id: msg.msg_id,
      agent_id,
      agent_name,
      thread_title,
      created_thread: created,
      truncated,
      originalBytes,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        // Echo back so the extension's preflight succeeds. The actual
        // origin gate for this route is the loopback Host check above.
        "access-control-allow-origin": req.headers.get("origin") ?? "*",
        "access-control-allow-credentials": "false",
        "vary": "origin",
      },
    },
  );
}

export function handlePageCaptureOptions(req: Request): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": req.headers.get("origin") ?? "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
      "vary": "origin",
    },
  });
}
