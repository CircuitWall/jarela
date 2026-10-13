import { WhatsAppBridgeAdapter } from "../../whatsapp";
import { removeWhatsAppAuth } from "./auth-state";
import type { BridgeModule } from "../../types";

export const whatsappBridgeModule: BridgeModule = {
  kind: "whatsapp",
  label: "WhatsApp",
  description: "Connect a WhatsApp account and route its chats to agents.",
  setupInstructions: "Enable the bridge and scan the QR code with WhatsApp → Linked Devices.",
  remoteIdLabel: "JID",
  remoteIdPlaceholder: "5511999990000@s.whatsapp.net or <group-id>@g.us",
  chatDirectory: true,
  chatLookup: {
    inputType: "tel",
    placeholder: "Find by phone (e.g. +1 555 123 4567)",
    notFoundMessage: "That number isn't on WhatsApp.",
    description: "WhatsApp syncs recent chats. Search by phone number to find other contacts.",
  },
  pairing: {
    actionLabel: "Re-pair",
    confirmMessage: "Re-pair this bridge? This wipes the current WhatsApp session and shows a new QR code.",
    qrAlt: "WhatsApp pairing QR",
    qrInstructions: "Open WhatsApp on your phone → Settings → Linked Devices → Link a device → scan this code.",
  },
  groupEventSubscriptions: true,
  attachmentDescription:
    "Text, image captions, and image / sticker payloads reach the agent. Audio, video, and documents are forwarded as attachments; their contents require model support. Location and contact cards are flattened into text.",
  createAdapter: (bridgeId) => new WhatsAppBridgeAdapter(bridgeId),
  removeAuth: removeWhatsAppAuth,
};