import { describe, it, expect } from "vitest";
import type AnthropicNS from "@anthropic-ai/sdk";
import { isCopilotClaudeModel } from "./github-copilot";

describe("isCopilotClaudeModel", () => {
  it.each([
    "claude-3.5-sonnet",
    "claude-sonnet-4",
    "claude-opus-4",
    "claude-haiku-4-5",
    "Github-Opus4.6",
    "copilot-claude-3.5-sonnet",
    "sonnet4",
    "haiku4.5",
  ])("recognizes %s as a Claude-family Copilot model", (id) => {
    expect(isCopilotClaudeModel(id)).toBe(true);
  });

  it.each([
    "gpt-4o",
    "gpt-5",
    "o1",
    "gemini-2.0-flash",
    "gemini-2.5-pro",
    "",
  ])("does not route %s through the Messages API", (id) => {
    expect(isCopilotClaudeModel(id)).toBe(false);
  });
});

describe("Claude-via-Copilot routing", () => {
  // We exercise the wire-level decision by stubbing the Anthropic SDK's
  // fetch and asserting (a) the Copilot Messages endpoint is hit, (b) the
  // request is authenticated via Bearer (not x-api-key), and (c) the body
  // carries cache_control on the system, last tool, and last tool_result.
  it("posts to api.githubcopilot.com/v1/messages with cache markers and Bearer auth", async () => {
    const captured: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const stubFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
      const body = init?.body ? JSON.parse(init.body as string) : null;
      captured.push({ url, headers, body });
      return new Response("not-a-real-response", { status: 500 });
    };

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const {
      buildAnthropicMessageBody,
    } = await import("./anthropic");

    const client = new Anthropic({
      apiKey: "",
      authToken: "fake-copilot-session-token",
      baseURL: "https://api.githubcopilot.com",
      maxRetries: 0,
      fetch: stubFetch,
      defaultHeaders: {
        "Editor-Version": "vscode/1.85.0",
        "Copilot-Integration-Id": "vscode-chat",
      },
    });

    const body = buildAnthropicMessageBody(
      "claude-sonnet-4",
      [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "t1", type: "function", function: { name: "search", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "t1", content: "result body" },
      ],
      { max_tokens: 256 },
      [{ type: "function", function: { name: "search", description: "", parameters: { type: "object", properties: {}, required: [] } } }],
    );

    await expect(
      client.messages.create(body as AnthropicNS.Messages.MessageCreateParamsNonStreaming),
    ).rejects.toThrow();

    expect(captured.length).toBeGreaterThan(0);
    const req = captured[0];
    expect(req.url).toBe("https://api.githubcopilot.com/v1/messages");
    expect(req.headers["authorization"]).toBe("Bearer fake-copilot-session-token");
    expect(req.headers["editor-version"]).toBe("vscode/1.85.0");
    expect(req.headers["copilot-integration-id"]).toBe("vscode-chat");

    const reqBody = req.body as {
      system: Array<{ cache_control?: { type: string } }>;
      tools: Array<{ cache_control?: { type: string } }>;
      messages: Array<{ content: Array<{ type: string; cache_control?: { type: string } }> }>;
    };
    expect(reqBody.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(reqBody.tools[reqBody.tools.length - 1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    const lastMsg = reqBody.messages[reqBody.messages.length - 1];
    const toolResult = lastMsg.content.find((b) => b.type === "tool_result");
    expect(toolResult?.cache_control).toEqual({ type: "ephemeral" });
  });
});
