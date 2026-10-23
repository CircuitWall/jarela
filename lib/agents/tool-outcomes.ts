import type { StreamChunk } from "./base";

type Outcome = "pending" | "succeeded" | "failed" | "rejected";
type ToolCall = { name: string; outcome: Outcome };

function resultRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function failed(result: Record<string, unknown> | null): boolean {
  return !!result && (result.ok === false || result.success === false
    || result.isError === true || result.is_error === true
    || result.status === "error" || result.status === "failed"
    || (result.error !== undefined && result.error !== null && result.error !== false && result.error !== ""));
}

export function unwrapInvokedToolName(name: string, args: Record<string, unknown>): string {
  if (name !== "invoke_tool") return name;
  const target = args.name;
  return typeof target === "string" && target.trim() ? target.trim() : name;
}

export class ToolOutcomes {
  private readonly calls = new Map<string, ToolCall>();

  observe(chunk: StreamChunk): void {
    const data = chunk.data;
    if (typeof data.id !== "string") return;
    if (chunk.type === "tool_call") {
      const args = resultRecord(data.arguments) ?? {};
      const name = unwrapInvokedToolName(typeof data.name === "string" ? data.name : "", args);
      if (name) this.calls.set(data.id, { name, outcome: "pending" });
      return;
    }
    if (chunk.type !== "tool_result") return;
    const call = this.calls.get(data.id);
    if (!call) return;
    const result = resultRecord(data.result);
    const invokedResult = data.name === "invoke_tool" ? resultRecord(result?.result) : null;
    if (result?.status === "rejected" || result?.status === "blocked") {
      call.outcome = "rejected";
    } else if (data.status === "error" || failed(result)
      || failed(invokedResult)) {
      call.outcome = "failed";
    } else if (result?.async === true || invokedResult?.async === true) {
      call.outcome = "pending";
    } else {
      call.outcome = "succeeded";
    }
  }

  successfulNames(): string[] {
    return [...this.calls.values()].filter((call) => call.outcome === "succeeded").map((call) => call.name);
  }

  possiblyChangedNames(): string[] {
    return [...this.calls.values()].filter((call) => call.outcome !== "rejected").map((call) => call.name);
  }
}