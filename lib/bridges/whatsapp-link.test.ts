import { describe, expect, it } from "vitest";
import { whatsappChatLink } from "./whatsapp-link";

describe("whatsappChatLink", () => {
  it("links 1:1 phone-number chats to wa.me", () => {
    expect(whatsappChatLink("15551234567@s.whatsapp.net")).toBe("https://wa.me/15551234567");
    expect(whatsappChatLink("4915112345678:23@s.whatsapp.net")).toBe("https://wa.me/4915112345678");
    expect(whatsappChatLink("15551234567@c.us")).toBe("https://wa.me/15551234567");
  });

  it("returns null for chats WhatsApp has no permalink for", () => {
    for (const jid of [
      "120363025246125486@g.us",
      "123456789012345@lid",
      "120363144038483540@newsletter",
      "status@broadcast",
      "15551234567",
      "",
      null,
      undefined,
    ]) {
      expect(whatsappChatLink(jid)).toBeNull();
    }
  });

  it("rejects ids that are not E.164 digits", () => {
    expect(whatsappChatLink("0123456789@s.whatsapp.net")).toBeNull();
    expect(whatsappChatLink("12345@s.whatsapp.net")).toBeNull();
    expect(whatsappChatLink("1234567890123456@s.whatsapp.net")).toBeNull();
    expect(whatsappChatLink("+15551234567@s.whatsapp.net")).toBeNull();
  });
});
