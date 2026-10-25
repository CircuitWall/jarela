import { describe, expect, it, vi } from "vitest";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { MCPAdapter } from "@langchain/mcp-adapters";
import { createServer } from "node:http";
import { includeMcpStructuredContent } from "./tool-results";

type HookRequest = Parameters<typeof includeMcpStructuredContent>[0];

function applyHook(result: HookRequest["result"]) {
  return includeMcpStructuredContent({ name: "lookup", args: {}, serverName: "test", result }, {}, {});
}

describe("MCP structured results", () => {
  it("leaves text-only and multimodal results without structured output unchanged", () => {
    expect(applyHook(["plain text", []])).toBeUndefined();
    expect(applyHook([[{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], []])).toBeUndefined();
    expect(applyHook(["plain text", [{ type: "mcp_meta", data: { private_marker: "not-for-model" } }]])).toBeUndefined();
  });

  it("preserves original content and artifacts without exposing protocol metadata", () => {
    const artifacts = [
      { type: "mcp_structured_content", data: { items: [{ id: 42 }], next: null } },
      { type: "mcp_meta", data: { private_marker: "not-for-model" } },
    ];
    expect(applyHook(["Found one item", artifacts])).toEqual({
      result: [
        [
          { type: "text", text: "Found one item" },
          { type: "text", text: 'Structured result (JSON):\n{"items":[{"id":42}],"next":null}' },
        ],
        artifacts,
      ],
    });
  });

  it("retains images, audio, and resource links alongside structured output", () => {
    const content = [
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
      { type: "file", url: "https://example.com/report", mimeType: "application/pdf" },
    ];
    const artifacts = [{ type: "mcp_structured_content", data: {} }];
    expect(applyHook([content, artifacts])).toEqual({
      result: [[...content, { type: "text", text: "Structured result (JSON):\n{}" }], artifacts],
    });
  });

  it("makes structured-only results visible through a real plain-argument LangChain invocation", async () => {
    const result: HookRequest["result"] = ["", [
      { type: "mcp_structured_content", data: { count: 0, enabled: false, items: [] } },
      { type: "mcp_meta", data: { private_marker: "not-for-model" } },
    ]];
    const tool = new DynamicStructuredTool({
      name: "lookup",
      description: "Synthetic structured result",
      schema: z.object({}),
      responseFormat: "content_and_artifact",
      func: async () => {
        const modified = await applyHook(result);
        return modified?.result ?? result;
      },
    });

    const output = await tool.invoke({});
    expect(output).toEqual([
      { type: "text", text: 'Structured result (JSON):\n{"count":0,"enabled":false,"items":[]}' },
    ]);
    expect(JSON.stringify(output)).not.toContain("not-for-model");
  });

  it.each([false, true])("preserves real MCP HTTP results without masking errors (isError=%s)", async (isError) => {
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string };
      };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      switch (message.method) {
        case "initialize":
          result = { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
          break;
        case "tools/list":
          result = { tools: [{ name: "lookup", description: "Structured fixture", inputSchema: { type: "object", properties: {} } }] };
          break;
        case "tools/call":
          result = {
            content: [{ type: "text", text: "One match" }],
            structuredContent: { items: [{ id: 42 }] },
            _meta: { private_marker: "not-for-model" },
            isError,
          };
          break;
        default:
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" },
          }));
          return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0", id: message.id, result,
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP fixture address");
    const afterToolCall = vi.fn(includeMcpStructuredContent);
    const adapter = new MCPAdapter({
      servers: { fixture: { transport: "http", url: `http://127.0.0.1:${address.port}`, mode: "legacy" } },
      prefixToolNameWithServerName: false,
      afterToolCall,
    });
    try {
      const tools = await adapter.listTools();
      expect(tools).toHaveLength(1);
      if (isError) {
        await expect(tools[0].invoke({})).rejects.toThrow("One match");
        expect(afterToolCall).not.toHaveBeenCalled();
      } else {
        expect(await tools[0].invoke({})).toEqual([
          { type: "text", text: "One match" },
          { type: "text", text: 'Structured result (JSON):\n{"items":[{"id":42}]}' },
        ]);
        expect(afterToolCall).toHaveBeenCalledOnce();
      }
    } finally {
      await adapter.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
