import { describe, it, expect, vi } from "vitest";

const enabledRef = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/stores/app-settings", () => ({
  isRedactionEnabled: () => enabledRef.value,
}));

import { withMaskRun, getMaskRunContext } from "./context";
import { maskInvokeMessages, passthroughTools } from "./mask-messages";
import type { InvokeMessage } from "@/lib/tools/types";

const FAKE_ANT = "sk-ant-abc123def456ghi789jkl000"; // jarela-secret-ok

function getRun() {
  const run = getMaskRunContext();
  if (!run) throw new Error("no mask run context");
  return run;
}

describe("maskInvokeMessages", () => {
  it("returns input unchanged when not inside a MaskRunContext", () => {
    const messages: InvokeMessage[] = [{ role: "user", content: `key ${FAKE_ANT}` }];
    const out = maskInvokeMessages(messages);
    expect(out).toBe(messages);
  });

  it("masks string content on user messages and records a per-message summary", () => {
    enabledRef.value = true;
    withMaskRun(() => {
      const messages: InvokeMessage[] = [
        { role: "user", content: `here is the key ${FAKE_ANT} please` },
      ];
      const out = maskInvokeMessages(messages);
      expect(out[0].content).toMatch(/«SECRET:[a-z0-9]+ type=anthropic_api_key»/);
      expect(out[0].content).not.toContain(FAKE_ANT);
      const summary = getRun().summaries.get("msg:0:user");
      expect(summary?.find((e) => e.type_hint === "anthropic_api_key")?.count).toBe(1);
    });
  });

  it("masks text parts inside ContentPart[] but leaves image parts alone", () => {
    enabledRef.value = true;
    withMaskRun(() => {
      const messages: InvokeMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: `secret ${FAKE_ANT}` },
            { type: "image", media_type: "image/png", data: "iVBORw0=" },
          ],
        },
      ];
      const out = maskInvokeMessages(messages);
      const parts = out[0].content as Array<{ type: string; text?: string }>;
      expect(parts[0].type).toBe("text");
      expect(parts[0].text).toMatch(/«SECRET:[a-z0-9]+ type=anthropic_api_key»/);
      expect(parts[1].type).toBe("image");
    });
  });

  it("masks JSON-encoded tool-call arguments, falling back to text on parse failure", () => {
    enabledRef.value = true;
    withMaskRun(() => {
      const messages: InvokeMessage[] = [
        {
          role: "assistant",
          content: "calling…",
          tool_calls: [
            {
              id: "tc1",
              type: "function",
              function: {
                name: "send_email",
                arguments: JSON.stringify({ body: `your key is ${FAKE_ANT}` }),
              },
            },
            // Malformed JSON: should fall back to plain-text masking.
            {
              id: "tc2",
              type: "function",
              function: { name: "raw", arguments: `{key=${FAKE_ANT}}` },
            },
          ],
        },
      ];
      const out = maskInvokeMessages(messages);
      const tcs = out[0].tool_calls!;
      expect(tcs[0].function.arguments).toMatch(/«SECRET:[a-z0-9]+ type=anthropic_api_key»/);
      expect(tcs[0].function.arguments).not.toContain(FAKE_ANT);
      expect(tcs[1].function.arguments).toMatch(/«SECRET:[a-z0-9]+ type=anthropic_api_key»/);
    });
  });

  it("does not record a summary entry when the message is clean", () => {
    enabledRef.value = true;
    withMaskRun(() => {
      maskInvokeMessages([{ role: "user", content: "no secrets" }]);
      expect(getRun().summaries.size).toBe(0);
    });
  });

  it("returns input unchanged when redaction is disabled", () => {
    enabledRef.value = false;
    withMaskRun(() => {
      const messages: InvokeMessage[] = [{ role: "user", content: `key ${FAKE_ANT}` }];
      const out = maskInvokeMessages(messages);
      expect(out[0].content).toBe(`key ${FAKE_ANT}`);
    });
  });
});

describe("passthroughTools", () => {
  it("returns the input array unchanged (tool defs hold no user secrets)", () => {
    const tools = [
      {
        type: "function" as const,
        function: { name: "x", description: "", parameters: { type: "object" as const, properties: {}, required: [] } },
      },
    ];
    expect(passthroughTools(tools)).toBe(tools);
  });
});
