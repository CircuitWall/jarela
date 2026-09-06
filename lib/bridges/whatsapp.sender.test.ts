import { describe, expect, it } from "vitest";
import { resolveWhatsAppSender } from "./whatsapp";

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
});