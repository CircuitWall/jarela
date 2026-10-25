import type { MCPAdapterConfig } from "@langchain/mcp-adapters";

// Plain-argument tool invocation drops LangChain artifacts. Keep structured
// output usable by the agent without exposing private MCP protocol metadata.
export const includeMcpStructuredContent: NonNullable<MCPAdapterConfig["afterToolCall"]> = ({
  result: [content, artifacts],
}) => {
  const structured = artifacts.find((artifact) => artifact.type === "mcp_structured_content");
  if (!structured) return;

  return {
    result: [
      [
        ...(typeof content === "string" ? (content ? [{ type: "text", text: content }] : []) : content),
        { type: "text", text: `Structured result (JSON):\n${JSON.stringify(structured.data)}` },
      ],
      artifacts,
    ],
  };
};
