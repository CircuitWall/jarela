import { describe, expect, it, vi } from "vitest";
import type { ModelProvider, ProviderMessage } from "./types";

const sent = vi.hoisted(() => [] as ProviderMessage[][]);

vi.mock("@/lib/stores/app-settings", () => ({ isRedactionEnabled: () => true }));
vi.mock("./external", () => ({ loadExternalProviders: () => ({}) }));
vi.mock("./builtins", () => ({}));
vi.mock("./registry", () => {
  const echo: ModelProvider = {
    name: "echo",
    async chat(_model, messages) {
      sent.push(messages);
      const echoed = String(messages[0].content);
      return { stream: (async function* () { yield echoed; })() };
    },
  };
  return {
    getBuiltinProviderNames: () => new Set(["echo"]),
    getBuiltinProviders: () => ({ echo }),
  };
});

import { getProvider } from "./index";

const FAKE_ANT = "sk-ant-abc123def456ghi789jkl000"; // jarela-secret-ok

describe("getProvider", () => {
  it("returns a provider whose outbound traffic is redacted", async () => {
    const provider = getProvider("echo");
    expect(getProvider("echo")).toBe(provider);
    const { stream } = await provider.chat("m", [{ role: "user", content: `key ${FAKE_ANT}` }], {});
    let reply = "";
    for await (const chunk of stream) reply += chunk;
    expect(JSON.stringify(sent)).not.toContain(FAKE_ANT);
    expect(String(sent[0][0].content)).toMatch(/^key «SECRET:/);
    expect(reply).toBe(`key ${FAKE_ANT}`);
  });
});
