import { describe, expect, it, vi } from "vitest";
import { WhatsAppBridgeAdapter } from "./whatsapp";

describe("WhatsApp synthetic event dedupe", () => {
  it("suppresses repeated synthetic events within TTL", () => {
    const adapter = new WhatsAppBridgeAdapter("bridge-test") as unknown as {
      shouldSuppressSyntheticEvent: (
        remote_jid: string,
        event: { type: "group_profile_update" | "group_participants_update"; subtype: string },
        text: string,
        actorJid: string | null,
      ) => boolean;
      suppressSyntheticUntilTs: number;
    };

    adapter.suppressSyntheticUntilTs = 0;
    const event = { type: "group_profile_update" as const, subtype: "subject" };
    const first = adapter.shouldSuppressSyntheticEvent("120@g.us", event, "Alice changed the subject to X", "alice@s.whatsapp.net");
    const second = adapter.shouldSuppressSyntheticEvent("120@g.us", event, "Alice changed the subject to X", "alice@s.whatsapp.net");

    expect(first).toBe(false);
    expect(second).toBe(true);
  });

  it("suppresses synthetic events during immediate post-connect window", () => {
    const adapter = new WhatsAppBridgeAdapter("bridge-test") as unknown as {
      shouldSuppressSyntheticEvent: (
        remote_jid: string,
        event: { type: "group_profile_update" | "group_participants_update"; subtype: string },
        text: string,
        actorJid: string | null,
      ) => boolean;
      suppressSyntheticUntilTs: number;
    };

    adapter.suppressSyntheticUntilTs = Date.now() + 60_000;
    const event = { type: "group_participants_update" as const, subtype: "add" };
    const suppressed = adapter.shouldSuppressSyntheticEvent("120@g.us", event, "Bob added Carol to the group.", "bob@s.whatsapp.net");

    expect(suppressed).toBe(true);
  });

  it("allows same signature after TTL expiry", () => {
    const adapter = new WhatsAppBridgeAdapter("bridge-test") as unknown as {
      shouldSuppressSyntheticEvent: (
        remote_jid: string,
        event: { type: "group_profile_update" | "group_participants_update"; subtype: string },
        text: string,
        actorJid: string | null,
      ) => boolean;
      suppressSyntheticUntilTs: number;
    };

    adapter.suppressSyntheticUntilTs = 0;
    const event = { type: "group_profile_update" as const, subtype: "description" };

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(1_000);
    const first = adapter.shouldSuppressSyntheticEvent("120@g.us", event, "Updated description", "alice@s.whatsapp.net");

    nowSpy.mockReturnValueOnce(1_000 + (6 * 60 * 60 * 1000) + 1);
    const afterTtl = adapter.shouldSuppressSyntheticEvent("120@g.us", event, "Updated description", "alice@s.whatsapp.net");

    nowSpy.mockRestore();

    expect(first).toBe(false);
    expect(afterTtl).toBe(false);
  });
});
