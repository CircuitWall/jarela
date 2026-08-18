import { describe, expect, it } from "vitest";
import { formatBridgePrompt, parseBridgePrompt } from "./message-role";

describe("bridge prompt envelope", () => {
  it("round-trips DM prompt metadata and body", () => {
    const raw = formatBridgePrompt({
      bridge_id: "b1",
      chat_id: "dm@jid",
      chat_name: "Alice",
      is_group: false,
      role: "counterpart",
      sender_id: "alice@jid",
      sender_name: "Alice",
      text: "hello from dm",
    });
    const parsed = parseBridgePrompt(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.bridgeId).toBe("b1");
    expect(parsed?.chatJid).toBe("dm@jid");
    expect(parsed?.isGroup).toBe(false);
    expect(parsed?.senderJid).toBe("alice@jid");
    expect(parsed?.body).toBe("hello from dm");
  });

  it("round-trips group prompt metadata and body", () => {
    const raw = formatBridgePrompt({
      bridge_id: "b1",
      chat_id: "group@jid",
      chat_name: "Family Group",
      is_group: true,
      role: "counterpart",
      sender_id: "bob@jid",
      sender_name: "Bob",
      text: "group message",
    });
    const parsed = parseBridgePrompt(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.chatJid).toBe("group@jid");
    expect(parsed?.chatName).toBe("Family Group");
    expect(parsed?.isGroup).toBe(true);
    expect(parsed?.senderName).toBe("Bob");
    expect(parsed?.body).toBe("group message");
  });

  it("marks synthetic group updates as event envelopes", () => {
    const raw = formatBridgePrompt({
      bridge_id: "b1",
      chat_id: "group@jid",
      chat_name: "Family Group",
      is_group: true,
      role: "counterpart",
      sender_id: "admin@jid",
      sender_name: "Admin",
      text: "Admin changed the group subject to \"Weekend Plan\".",
      event: { type: "group_profile_update", subtype: "subject" },
    });
    expect(raw).toContain("[event_type:group_profile_update]");
    expect(raw).toContain("[event_subtype:subject]");
    expect(raw).toContain("not a normal chat message");
    const parsed = parseBridgePrompt(raw);
    expect(parsed?.chatJid).toBe("group@jid");
    expect(parsed?.body).toContain("changed the group subject");
  });

  it("parses envelopes with prose preface before bracket headers", () => {
    const raw = [
      "The paired user themselves sent the message below.",
      "",
      "[bridge:b1]",
      "[chat_id:dm@jid]",
      "[chat_name:Alice]",
      "[chat_type:dm]",
      "[sender_id:alice@jid]",
      "[sender_name:Alice]",
      "",
      "body",
    ].join("\n");
    const parsed = parseBridgePrompt(raw);
    expect(parsed?.bridgeId).toBe("b1");
    expect(parsed?.body).toBe("body");
  });

  it("accepts legacy key names for compatibility", () => {
    const raw = [
      "[bridge:b1]",
      "[chat_jid:legacy@jid]",
      "[chat_name:Legacy]",
      "[chat_type:dm]",
      "[sender_jid:sender@jid]",
      "[sender_name:Sender]",
      "",
      "legacy body",
    ].join("\n");
    const parsed = parseBridgePrompt(raw);
    expect(parsed?.chatJid).toBe("legacy@jid");
    expect(parsed?.senderJid).toBe("sender@jid");
    expect(parsed?.body).toBe("legacy body");
  });

  it("returns null when not a bridge envelope", () => {
    expect(parseBridgePrompt("plain text")).toBeNull();
  });
});
