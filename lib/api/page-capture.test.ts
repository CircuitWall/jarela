import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be set up before importing the handler.
const listThreadsByAgentMock = vi.fn();
const createThreadMock = vi.fn();
const addMessageMock = vi.fn();
const getDefaultAgentConfigMock = vi.fn();
const listAgentConfigsMock = vi.fn();
const publishMock = vi.fn();

vi.mock("@/lib/stores/threads", () => ({
  listThreadsByAgent: (...a: unknown[]) => listThreadsByAgentMock(...a),
  createThread: (...a: unknown[]) => createThreadMock(...a),
  addMessage: (...a: unknown[]) => addMessageMock(...a),
}));
vi.mock("@/lib/stores/agent-configs", () => ({
  getDefaultAgentConfig: (...a: unknown[]) => getDefaultAgentConfigMock(...a),
  listAgentConfigs: (...a: unknown[]) => listAgentConfigsMock(...a),
}));
vi.mock("@/lib/notifications/bus", () => ({
  publish: (...a: unknown[]) => publishMock(...a),
}));

import { handlePageCapture, MAX_TEXT_BYTES } from "./page-capture";

beforeEach(() => {
  listThreadsByAgentMock.mockReset();
  createThreadMock.mockReset();
  addMessageMock.mockReset();
  getDefaultAgentConfigMock.mockReset();
  listAgentConfigsMock.mockReset();
  publishMock.mockReset();

  addMessageMock.mockImplementation((thread_id: string, role: string, content: string) => ({
    msg_id: "m-1", thread_id, role, content, created_at: "2026-05-22T00:00:00.000Z",
  }));
  // Reasonable defaults for tests that don't care about routing details:
  // a default agent exists, and it has one thread "t1".
  getDefaultAgentConfigMock.mockReturnValue({ id: "default-agent", name: "Default" });
  listAgentConfigsMock.mockReturnValue([{ id: "default-agent", name: "Default" }]);
  listThreadsByAgentMock.mockImplementation((agent_id: string) =>
    agent_id === "default-agent" ? [{ thread_id: "t1", title: "Recent chat" }] : []
  );
});

const validBody = {
  url: "https://example.com/article",
  title: "Example Article",
  selector: "main > article > p:nth-of-type(2)",
  tagName: "P",
  text: "Hello world.",
  capturedAt: "2026-05-22T12:00:00.000Z",
};

function makeReq(body: unknown, host = "localhost:4312"): Request {
  return new Request("http://localhost:4312/api/v1/page-capture", {
    method: "POST",
    headers: { "content-type": "application/json", host },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handlePageCapture — auth", () => {
  it("returns 403 when host is not loopback", async () => {
    const res = await handlePageCapture(makeReq(validBody, "evil.com"));
    expect(res.status).toBe(403);
    expect(addMessageMock).not.toHaveBeenCalled();
  });

  it("allows 127.0.0.1 host", async () => {
    const res = await handlePageCapture(makeReq(validBody, "127.0.0.1:4312"));
    expect(res.status).toBe(200);
  });
});

describe("handlePageCapture — validation", () => {
  it("rejects non-JSON body with 400", async () => {
    const res = await handlePageCapture(makeReq("not json"));
    expect(res.status).toBe(400);
  });

  it("rejects missing url", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { url, ...withoutUrl } = validBody;
    const res = await handlePageCapture(makeReq(withoutUrl));
    expect(res.status).toBe(400);
  });

  it("rejects malformed url", async () => {
    const res = await handlePageCapture(makeReq({ ...validBody, url: "not-a-url" }));
    expect(res.status).toBe(400);
  });

  it("rejects missing capturedAt", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { capturedAt, ...rest } = validBody;
    const res = await handlePageCapture(makeReq(rest));
    expect(res.status).toBe(400);
  });

  it("rejects oversized title", async () => {
    const res = await handlePageCapture(makeReq({ ...validBody, title: "x".repeat(1000) }));
    expect(res.status).toBe(400);
  });
});

describe("handlePageCapture — thread targeting", () => {
  it("routes to the default agent's most recent thread", async () => {
    listThreadsByAgentMock.mockReturnValue([
      { thread_id: "default-recent", title: "Yesterday's chat" },
      { thread_id: "default-older", title: "Older" },
    ]);
    const res = await handlePageCapture(makeReq(validBody));
    expect(res.status).toBe(200);
    expect(listThreadsByAgentMock).toHaveBeenCalledWith("default-agent", 1);
    expect(addMessageMock).toHaveBeenCalledWith("default-recent", "user", expect.any(String));
    expect(createThreadMock).not.toHaveBeenCalled();
  });

  it("ignores threads belonging to other agents", async () => {
    // Even if agent B has more recent activity, the capture goes to the
    // default agent's most recent thread (or a new one under the default).
    getDefaultAgentConfigMock.mockReturnValue({ id: "default-agent", name: "Default" });
    listAgentConfigsMock.mockReturnValue([
      { id: "default-agent", name: "Default" },
      { id: "other-agent", name: "Other" },
    ]);
    listThreadsByAgentMock.mockImplementation((agent_id: string) =>
      agent_id === "default-agent"
        ? [{ thread_id: "default-thread", title: "Mine" }]
        : [{ thread_id: "other-thread", title: "Theirs" }]
    );
    await handlePageCapture(makeReq(validBody));
    expect(addMessageMock).toHaveBeenCalledWith("default-thread", "user", expect.any(String));
  });

  it("creates a fresh thread under the default agent when it has none", async () => {
    listThreadsByAgentMock.mockReturnValue([]);
    createThreadMock.mockReturnValue({ thread_id: "fresh", title: "Browser captures" });

    const res = await handlePageCapture(makeReq(validBody));
    expect(res.status).toBe(200);
    expect(createThreadMock).toHaveBeenCalledWith("default-agent", "Browser captures");
    expect(addMessageMock).toHaveBeenCalledWith("fresh", "user", expect.any(String));
    const data = await res.json();
    expect(data.created_thread).toBe(true);
  });

  it("falls back to first agent when no default is set", async () => {
    getDefaultAgentConfigMock.mockReturnValue(null);
    listAgentConfigsMock.mockReturnValue([{ id: "first-agent", name: "First" }]);
    listThreadsByAgentMock.mockReturnValue([]);
    createThreadMock.mockReturnValue({ thread_id: "fresh", title: "Browser captures" });

    const res = await handlePageCapture(makeReq(validBody));
    expect(res.status).toBe(200);
    expect(listThreadsByAgentMock).toHaveBeenCalledWith("first-agent", 1);
    expect(createThreadMock).toHaveBeenCalledWith("first-agent", "Browser captures");
  });

  it("returns 503 when no agents are configured at all", async () => {
    getDefaultAgentConfigMock.mockReturnValue(null);
    listAgentConfigsMock.mockReturnValue([]);
    const res = await handlePageCapture(makeReq(validBody));
    expect(res.status).toBe(503);
    expect(createThreadMock).not.toHaveBeenCalled();
  });
});

describe("handlePageCapture — message body", () => {
  // The top-level beforeEach already wires up a default agent + "t1" thread.

  it("includes a 'Captured from' header with title and url", async () => {
    await handlePageCapture(makeReq(validBody));
    const body = addMessageMock.mock.calls[0][2] as string;
    expect(body).toContain("Captured from");
    expect(body).toContain("Example Article");
    expect(body).toContain("https://example.com/article");
  });

  it("includes the selector when provided", async () => {
    await handlePageCapture(makeReq(validBody));
    const body = addMessageMock.mock.calls[0][2] as string;
    expect(body).toContain("main > article > p:nth-of-type(2)");
  });

  it("uses the URL as fallback when no title is given", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { title, ...rest } = validBody;
    await handlePageCapture(makeReq(rest));
    const body = addMessageMock.mock.calls[0][2] as string;
    expect(body).toContain("https://example.com/article");
  });

  it("includes the captured text", async () => {
    await handlePageCapture(makeReq({ ...validBody, text: "the actual content here" }));
    const body = addMessageMock.mock.calls[0][2] as string;
    expect(body).toContain("the actual content here");
  });
});

describe("handlePageCapture — truncation", () => {
  // The top-level beforeEach already wires up a default agent + "t1" thread.

  it("does not flag short text as truncated", async () => {
    const res = await handlePageCapture(makeReq(validBody));
    const data = await res.json();
    expect(data.truncated).toBe(false);
    expect(data.originalBytes).toBe(Buffer.byteLength("Hello world.", "utf8"));
  });

  it("truncates oversized text and flags it in response + message body", async () => {
    const big = "x".repeat(MAX_TEXT_BYTES + 5000);
    const res = await handlePageCapture(makeReq({ ...validBody, text: big }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.truncated).toBe(true);
    expect(data.originalBytes).toBe(big.length); // 'x' is 1 byte each in utf8
    const body = addMessageMock.mock.calls[0][2] as string;
    expect(body).toContain("Truncated");
    // The stored body cannot exceed MAX_TEXT_BYTES + reasonable header overhead.
    // Check the captured text portion is at the cap.
    const textPortion = body.split("---")[1] ?? "";
    expect(Buffer.byteLength(textPortion.trim(), "utf8")).toBeLessThanOrEqual(MAX_TEXT_BYTES);
  });

  it("counts UTF-8 bytes (multibyte chars), not chars", async () => {
    // "🚀" is 4 bytes in UTF-8. If we stuffed the field with enough rockets to
    // exceed the byte cap but not the char cap, we should still truncate.
    const rocket = "🚀";
    const charCount = Math.floor(MAX_TEXT_BYTES / 2); // 2x more bytes than cap
    const text = rocket.repeat(charCount);
    const res = await handlePageCapture(makeReq({ ...validBody, text }));
    const data = await res.json();
    expect(data.truncated).toBe(true);
    expect(data.originalBytes).toBe(Buffer.byteLength(text, "utf8"));
  });
});

describe("handlePageCapture — bus", () => {
  // The top-level beforeEach already wires up a default agent + "t1" thread.

  it("publishes a thread_message_added event on success", async () => {
    await handlePageCapture(makeReq(validBody));
    expect(publishMock).toHaveBeenCalledTimes(1);
    const ev = publishMock.mock.calls[0][0];
    expect(ev.type).toBe("thread_message_added");
    expect(ev.thread_id).toBe("t1");
    expect(ev.agent_id).toBe("default-agent");
    expect(ev.source).toBe("page_capture");
    expect(typeof ev.ts).toBe("number");
  });

  it("does not publish on validation failure", async () => {
    await handlePageCapture(makeReq({ ...validBody, url: "nope" }));
    expect(publishMock).not.toHaveBeenCalled();
  });
});

describe("handlePageCapture — response shape", () => {
  // The top-level beforeEach already wires up a default agent + "t1" thread.

  it("returns thread_id, msg_id, agent info, and truncation metadata", async () => {
    const res = await handlePageCapture(makeReq(validBody));
    const data = await res.json();
    expect(data).toEqual({
      thread_id: "t1",
      msg_id: "m-1",
      agent_id: "default-agent",
      agent_name: "Default",
      thread_title: "Recent chat",
      created_thread: false,
      truncated: false,
      originalBytes: expect.any(Number),
    });
  });
});
