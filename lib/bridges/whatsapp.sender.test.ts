import { describe, expect, it } from "vitest";
import {
  humanList,
  normalizeUserJid,
  pickContactChatJid,
  pickRoutableJid,
  resolveWhatsAppSender,
  sanitizeMediaType,
  unwrapMessage,
} from "./whatsapp";
import { whatsappChatLink } from "./whatsapp-link";

describe("whatsapp payload helpers", () => {
  it("unwraps nested ephemeral and view-once envelopes", () => {
    const inner = { imageMessage: { caption: "secret" } };
    expect(unwrapMessage({ ephemeralMessage: { message: { viewOnceMessageV2: { message: inner } } } })).toBe(inner);
    expect(unwrapMessage({ documentWithCaptionMessage: { message: { documentMessage: { caption: "c" } } } }))
      .toEqual({ documentMessage: { caption: "c" } });
  });

  it("stops unwrapping a pathologically deep envelope", () => {
    let msg: Record<string, unknown> = { conversation: "deep" };
    for (let i = 0; i < 50; i++) msg = { ephemeralMessage: { message: msg } };
    expect(() => unwrapMessage(msg)).not.toThrow();
    expect(unwrapMessage(msg)).not.toHaveProperty("conversation");
  });

  it("only accepts allow-listed media types and strips parameters", () => {
    expect(sanitizeMediaType("Image/JPEG; charset=binary", "image", "image/jpeg")).toBe("image/jpeg");
    expect(sanitizeMediaType("text/html", "image", "image/jpeg")).toBe("image/jpeg");
    expect(sanitizeMediaType("image/png\r\nX-Injected: 1", "image", "image/jpeg")).toBe("image/jpeg");
    expect(sanitizeMediaType(undefined, "audio", "audio/ogg")).toBe("audio/ogg");
  });

  it("prefers a routable alt JID over an @lid primary", () => {
    expect(pickRoutableJid("123@lid", "15551234567@s.whatsapp.net")).toBe("15551234567@s.whatsapp.net");
    expect(pickRoutableJid("family@g.us", "123@lid")).toBe("family@g.us");
    expect(pickRoutableJid("123@lid", undefined)).toBe("123@lid");
  });

  it("keys contacts on the phone-number JID and rejects broadcasts", () => {
    expect(pickContactChatJid({ id: "123@lid", phoneNumber: "15551234567@s.whatsapp.net" })).toBe("15551234567@s.whatsapp.net");
    expect(pickContactChatJid({ id: "123@lid" })).toBe("123@lid");
    expect(pickContactChatJid({ id: "status@broadcast" })).toBeNull();
    expect(pickContactChatJid({})).toBeNull();
  });

  it("strips device suffixes and legacy hosts from user JIDs", () => {
    expect(normalizeUserJid("15551234567:23@s.whatsapp.net")).toBe("15551234567@s.whatsapp.net");
    expect(normalizeUserJid("15551234567@c.us")).toBe("15551234567@s.whatsapp.net");
    expect(normalizeUserJid(":5@s.whatsapp.net")).toBeNull();
    expect(normalizeUserJid("no-at-sign")).toBeNull();
    expect(normalizeUserJid(42)).toBeNull();
  });

  it("summarizes long participant lists and skips blanks", () => {
    expect(humanList(["a", " ", "b", "c"], 2)).toBe("a, b, and 1 more");
    expect(humanList(["", "  "], 3)).toBe("(none)");
  });

  it("links only the chats a routed message can actually be opened in", () => {
    const routed = pickRoutableJid("123@lid", "15551234567@s.whatsapp.net");
    expect(whatsappChatLink(routed)).toBe("https://wa.me/15551234567");
    expect(whatsappChatLink(pickRoutableJid("123@lid", undefined))).toBeNull();
    expect(whatsappChatLink(normalizeUserJid("15551234567:7@s.whatsapp.net"))).toBe("https://wa.me/15551234567");
  });
});

describe("resolveWhatsAppSender", () => {
  it("attributes user-authored DM replies to the paired account", () => {
    expect(resolveWhatsAppSender({
      fromMe: true,
      isGroup: false,
      remoteJid: "contact@s.whatsapp.net",
      participantJid: null,
      selfJid: "me@s.whatsapp.net",
      pushName: "Contact",
      chatName: "Contact",
      participantName: null,
    })).toEqual({
      senderJid: "me@s.whatsapp.net",
      senderName: "You",
    });
  });

  it("attributes counterpart DM messages to the chat contact", () => {
    expect(resolveWhatsAppSender({
      fromMe: false,
      isGroup: false,
      remoteJid: "contact@s.whatsapp.net",
      participantJid: null,
      selfJid: "me@s.whatsapp.net",
      pushName: "Contact",
      chatName: "Contact",
      participantName: null,
    })).toEqual({
      senderJid: "contact@s.whatsapp.net",
      senderName: "Contact",
    });
  });

  it("attributes group messages to the participant", () => {
    expect(resolveWhatsAppSender({
      fromMe: false,
      isGroup: true,
      remoteJid: "family@g.us",
      participantJid: "bob@s.whatsapp.net",
      selfJid: "me@s.whatsapp.net",
      pushName: "Bob",
      chatName: "Family",
      participantName: "Robert",
    })).toEqual({
      senderJid: "bob@s.whatsapp.net",
      senderName: "Robert",
    });
  });

  it("falls back past blank display names", () => {
    const base = {
      fromMe: false,
      selfJid: "me@s.whatsapp.net",
      participantName: null,
    };
    expect(resolveWhatsAppSender({ ...base, isGroup: false, remoteJid: "c@s.whatsapp.net", participantJid: null, pushName: "", chatName: "  Carol  " }))
      .toEqual({ senderJid: "c@s.whatsapp.net", senderName: "Carol" });
    expect(resolveWhatsAppSender({ ...base, isGroup: false, remoteJid: "c@s.whatsapp.net", participantJid: null, pushName: " ", chatName: null }))
      .toEqual({ senderJid: "c@s.whatsapp.net", senderName: "c@s.whatsapp.net" });
    expect(resolveWhatsAppSender({ ...base, isGroup: true, remoteJid: "g@g.us", participantJid: null, pushName: "", chatName: "G", participantName: "" }))
      .toEqual({ senderJid: "g@g.us", senderName: "g@g.us" });
  });
});