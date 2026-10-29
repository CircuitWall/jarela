export const TRUNCATED_TOOL_CALL_MESSAGE =
  "Model truncated a tool call at max_tokens. Increase the model output-token limit and retry; " +
  "the incomplete tool call was not executed.";

const INVALID_TOOL_ARGUMENTS_MESSAGE =
  "Provider returned malformed or incomplete tool-call arguments; expected a complete JSON object. " +
  "Tool calls from this model step were not executed. Retry with complete arguments or a larger output-token limit.";

export function parseToolArguments(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(INVALID_TOOL_ARGUMENTS_MESSAGE);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(INVALID_TOOL_ARGUMENTS_MESSAGE);
  }
  return value as Record<string, unknown>;
}
