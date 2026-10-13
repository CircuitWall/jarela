import { describe, expect, it } from "vitest";
import { getBridgeModule, isBridgeKind, listBridgeModules } from "./registry";

describe("bridge module registry", () => {
  it("exposes public metadata without adapter functions", () => {
    const modules = listBridgeModules();
    expect(modules).toHaveLength(1);
    expect(modules[0]).toMatchObject({
      kind: "whatsapp",
      label: "WhatsApp",
      chatDirectory: true,
      groupEventSubscriptions: true,
      pairing: { actionLabel: "Re-pair" },
    });
    expect("createAdapter" in modules[0]).toBe(false);
    expect("removeAuth" in modules[0]).toBe(false);
  });

  it("validates bridge kinds and resolves their modules", () => {
    expect(isBridgeKind("whatsapp")).toBe(true);
    expect(getBridgeModule("whatsapp")?.createAdapter).toBeTypeOf("function");
    expect(isBridgeKind("unknown-channel")).toBe(false);
    expect(getBridgeModule("unknown-channel")).toBeUndefined();
  });
});