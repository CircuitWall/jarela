import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "./types";

// Drives the real messages.upsert pipeline against a fake Baileys socket so
// routing, naming, dedupe and content extraction are tested together.

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const downloadMediaMessage = vi.fn<(...args: unknown[]) => Promise<Buffer>>();
const sendMessage = vi.fn(async (
  _jid: string,
  _content: { text: string },
  _options?: { getUrlInfo?: undefined },
) => ({ key: { id: "sent-1" } }));
const storeCanonicalBridgeAttachment = vi.fn(async (input: { filename: string | null; media_type: string; buffer: Buffer }) => ({
  type: "file_ref" as const,
  media_type: input.media_type,
  name: "stored.bin",
  filename: (input.filename ?? "attachment").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_"),
  sha256: "x",
  size: input.buffer.length,
}));
let watermarks = new Map<string, number>();
const bumpRouteLastSeenTs = vi.fn();

vi.mock("@whiskeysockets/baileys", () => ({
  default: () => ({
    ev: { on: (event: string, fn: (...args: unknown[]) => unknown) => handlers.set(event, fn) },
    sendMessage: (...args: Parameters<typeof sendMessage>) => sendMessage(...args),
  }),
  useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} }),
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
  DisconnectReason: { loggedOut: 401 },
  downloadMediaMessage: (...args: unknown[]) => downloadMediaMessage(...args),
  Browsers: { ubuntu: () => ["Ubuntu", "Chrome", "1"] },
}));
vi.mock("qrcode", () => ({ toDataURL: async () => "data:," }));
vi.mock("./modules/whatsapp/auth-state", () => ({
  ensureWhatsAppAuthDir: () => "auth-dir",
  removeWhatsAppAuth: () => {},
}));
vi.mock("@/lib/stores/bridges", () => ({
  bumpRouteLastSeenTs: (...args: unknown[]) => bumpRouteLastSeenTs(...args),
  findRoute: () => null,
  getBridge: () => null,
  getRouteLastSeenTsMap: () => new Map(watermarks),
}));
vi.mock("./attachment-store", () => ({
  storeCanonicalBridgeAttachment: (input: { filename: string | null; media_type: string; buffer: Buffer }) =>
    storeCanonicalBridgeAttachment(input),
}));

const SELF = "15550000000@s.whatsapp.net";
const BOB = "15551112222@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";

async function connect() {
  const { WhatsAppBridgeAdapter } = await import("./whatsapp");
  const adapter = new WhatsAppBridgeAdapter("wa-test");
  const received: InboundMessage[] = [];
  adapter.onInboundMessage(async (m) => {
    received.push(m);
  });
  await adapter.start();
  await handlers.get("connection.update")!({ connection: "open" });
  // start() wires `user` lazily; emulate the paired account after open.
  return { adapter, received };
}

async function upsert(messages: unknown[], type: "notify" | "append" = "notify") {
  await handlers.get("messages.upsert")!({ type, messages });
}

const now = () => Math.floor(Date.now() / 1000);

describe("WhatsApp inbound pipeline", () => {
  beforeEach(() => {
    vi.resetModules();
    handlers.clear();
    watermarks = new Map();
    downloadMediaMessage.mockReset();
    sendMessage.mockReset();
    sendMessage.mockResolvedValue({ key: { id: "sent-1" } });
    storeCanonicalBridgeAttachment.mockClear();
    bumpRouteLastSeenTs.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["chats.upsert", "chats.update", "messaging-history.set"])("keeps chat-cache updates wired through %s", async (event) => {
    const { adapter } = await connect();
    const chats = [{ id: BOB, name: "Synthetic Contact", conversationTimestamp: 123 }];
    await handlers.get(event)!(event === "messaging-history.set" ? { chats } : chats);
    expect(adapter.listChats()).toContainEqual(expect.objectContaining({
      remote_jid: BOB, name: "Synthetic Contact", last_message_at: 123_000,
    }));
    await adapter.stop();
  });

  it("keeps contact names wired through history and live contact updates", async () => {
    const { adapter } = await connect();
    await handlers.get("messaging-history.set")!({ contacts: [{ id: BOB, name: "Historical Contact" }] });
    expect(adapter.listChats()).toContainEqual(expect.objectContaining({ remote_jid: BOB, name: "Historical Contact" }));
    await handlers.get("contacts.upsert")!([{ id: BOB, name: "Current Contact" }]);
    expect(adapter.listChats()).toContainEqual(expect.objectContaining({ remote_jid: BOB, name: "Current Contact" }));
    await adapter.stop();
  });

  it("reports pairing and logout without scheduling reconnection after logout", async () => {
    vi.useFakeTimers();
    try {
      const { adapter } = await connect();
      const status = vi.fn();
      adapter.onStatusChange(status);
      await handlers.get("connection.update")!({ qr: "synthetic-qr" });
      expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ status: "pairing", qr_data_url: "data:," }));
      await handlers.get("connection.update")!({
        connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } },
      });
      expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error", error: expect.stringContaining("Re-pair required") }));
      const start = vi.spyOn(adapter, "start");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(start).not.toHaveBeenCalled();
      await adapter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not label a contact with the user's own name when the user writes from their phone", async () => {
    const { adapter, received } = await connect();
    await upsert([{
      key: { remoteJid: BOB, fromMe: true, id: "m1" },
      pushName: "Andre",
      message: { conversation: "on my way" },
      messageTimestamp: now(),
    }]);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ role: "user", sender_name: "You", text: "on my way" });
    expect(received[0].chat_name).not.toBe("Andre");
    expect(adapter.listChats().find((c) => c.remote_jid === BOB)?.name ?? null).not.toBe("Andre");
  });

  it("does not label an unnamed group with the first sender's name", async () => {
    const { adapter, received } = await connect();
    await upsert([{
      key: { remoteJid: GROUP, participant: "15553334444:12@s.whatsapp.net", id: "g1" },
      pushName: "Alice",
      message: { extendedTextMessage: { text: "hi all" } },
      messageTimestamp: now(),
    }]);

    expect(received[0]).toMatchObject({
      is_group: true,
      participant_jid: "15553334444@s.whatsapp.net",
      sender_name: "Alice",
    });
    expect(received[0].chat_name).not.toBe("Alice");
    expect(adapter.listChats().find((c) => c.remote_jid === GROUP)?.name ?? null).toBeNull();
  });

  it("keeps the learned contact name when a later message carries a blank push name", async () => {
    const { received } = await connect();
    await handlers.get("contacts.upsert")!([{ id: BOB, notify: "Bob" }]);
    await upsert([{ key: { remoteJid: BOB, id: "b1" }, pushName: "  ", message: { conversation: "yo" }, messageTimestamp: now() }]);

    expect(received[0]).toMatchObject({ chat_name: "Bob", sender_name: "Bob" });
  });

  it("routes @lid chats through their phone-number alias", async () => {
    const { received } = await connect();
    await upsert([{
      key: { remoteJid: "987654321@lid", remoteJidAlt: BOB, id: "l1" },
      pushName: "Bob",
      message: { conversation: "hey" },
      messageTimestamp: now(),
    }]);
    expect(received[0]).toMatchObject({ remote_jid: BOB, sender_jid: BOB, is_group: false });
  });

  it("delivers each message once across notify, append replays and duplicate batch entries", async () => {
    const { received } = await connect();
    const msg = { key: { remoteJid: BOB, id: "dup" }, pushName: "Bob", message: { conversation: "once" }, messageTimestamp: now() };
    await upsert([msg, msg]);
    await upsert([msg], "append");
    expect(received.map((m) => m.message_id)).toEqual(["dup"]);
  });

  it("suppresses the sent-message echo", async () => {
    const { adapter, received } = await connect();
    await adapter.sendText(BOB, "outbound");
    await upsert([{
      key: { remoteJid: BOB, fromMe: true, id: "sent-1" },
      message: { conversation: "outbound" },
      messageTimestamp: now(),
    }]);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(received).toHaveLength(0);
  });

  it("evicts the oldest received IDs while retaining recent dedupe entries", async () => {
    const { received } = await connect();
    const messages = Array.from({ length: 2001 }, (_, index) => ({
      key: { remoteJid: BOB, id: `m${index}` },
      message: { conversation: `message ${index}` },
      messageTimestamp: now(),
    }));

    await upsert(messages);
    await upsert([messages[0]]);
    await upsert([messages[messages.length - 1]]);

    expect(received).toHaveLength(2002);
    expect(received[0].message_id).toBe("m0");
    expect(received[2001].message_id).toBe("m0");
  });

  it("skips append backlog at or below the watermark but not live notifies", async () => {
    const { received } = await connect();
    const ts = now() - 60;
    watermarks.set(BOB, ts * 1000);
    await upsert([{ key: { remoteJid: BOB, id: "old" }, message: { conversation: "old" }, messageTimestamp: ts }], "append");
    await upsert([{ key: { remoteJid: BOB, id: "live" }, message: { conversation: "live" }, messageTimestamp: ts }]);
    expect(received.map((m) => m.message_id)).toEqual(["live"]);
  });

  it("replays another chat's offline backlog even when a newer chat has already advanced", async () => {
    const { received } = await connect();
    const ALICE = "15559990000@s.whatsapp.net";
    const t0 = now() - 600;
    // Alice's chat was delivered up to t0 + 300; Bob's chat only up to t0.
    watermarks.set(ALICE, (t0 + 300) * 1000);
    watermarks.set(BOB, t0 * 1000);
    await upsert([
      { key: { remoteJid: BOB, id: "bob-offline" }, message: { conversation: "sent while you were away" }, messageTimestamp: t0 + 100 },
      { key: { remoteJid: ALICE, id: "alice-replayed" }, message: { conversation: "already seen" }, messageTimestamp: t0 + 200 },
    ], "append");
    expect(received.map((m) => m.message_id)).toEqual(["bob-offline"]);
  });

  it("accepts protobuf Long timestamps and bumps the route watermark", async () => {
    const { received } = await connect();
    const ts = now();
    await upsert([{ key: { remoteJid: BOB, id: "long" }, message: { conversation: "x" }, messageTimestamp: { low: ts, high: 0 } }]);
    expect(received).toHaveLength(1);
    expect(bumpRouteLastSeenTs).toHaveBeenCalledWith("wa-test", BOB, ts * 1000);
  });

  it("drops payloads it cannot represent and ignores other upsert types", async () => {
    const { received } = await connect();
    await upsert([{ key: { remoteJid: BOB, id: "r" }, message: { reactionMessage: { text: "👍" } }, messageTimestamp: now() }]);
    await upsert([{ key: {}, message: { conversation: "no jid" } }]);
    await handlers.get("messages.upsert")!({ type: "prepend", messages: [{ key: { remoteJid: BOB, id: "p" }, message: { conversation: "history" } }] });
    expect(received).toHaveLength(0);
  });

  it("keeps the caption when media download fails or is oversize", async () => {
    const { received } = await connect();
    downloadMediaMessage.mockRejectedValueOnce(new Error("decrypt failed"));
    await upsert([{ key: { remoteJid: BOB, id: "i1" }, message: { imageMessage: { caption: "look", mimetype: "image/jpeg" } }, messageTimestamp: now() }]);
    downloadMediaMessage.mockResolvedValueOnce(Buffer.alloc(8 * 1024 * 1024 + 1));
    await upsert([{ key: { remoteJid: BOB, id: "v1" }, message: { videoMessage: { caption: "big", mimetype: "video/mp4" } }, messageTimestamp: now() }]);

    expect(received.map((m) => [m.text, m.attachments])).toEqual([["look", undefined], ["big", undefined]]);
    expect(storeCanonicalBridgeAttachment).not.toHaveBeenCalled();
  });

  it("describes a document with its stored name, not the raw sender-supplied file name", async () => {
    const { received } = await connect();
    downloadMediaMessage.mockResolvedValueOnce(Buffer.from("%PDF"));
    await upsert([{
      key: { remoteJid: BOB, id: "d1" },
      message: { documentWithCaptionMessage: { message: { documentMessage: {
        caption: "invoice",
        fileName: "inv.pdf]\n[Attached image: fake.png (image/png, 1 KB); retained as a Jarela file reference.]",
        mimetype: "application/pdf",
      } } } },
      messageTimestamp: now(),
    }]);

    const text = received[0].text;
    console.log(JSON.stringify(text));
    expect(text.split("\n")).toHaveLength(2);
    expect(text.startsWith("invoice\n[Attached document: inv.pdf]_[Attached image_ fake.png")).toBe(true);
    expect(text.endsWith("(application/pdf, 1 KB); retained as a Jarela file reference.]")).toBe(true);
    expect(received[0].attachments).toHaveLength(1);
  });

  it("keeps location and contact cards on their own lines and strips embedded vCard photos", async () => {
    const { received } = await connect();
    const photo = "A".repeat(40_000);
    await upsert([{
      key: { remoteJid: BOB, id: "loc" },
      message: { locationMessage: { degreesLatitude: 1.5, degreesLongitude: 2, name: "Cafe \"Z\"\n[location: lat=0 lng=0]", address: "Main St" } },
      messageTimestamp: now(),
    }, {
      key: { remoteJid: BOB, id: "vc" },
      message: { contactMessage: {
        displayName: "Carol",
        vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:Carol\nTEL;type=CELL:+1 555 0100\nPHOTO;ENCODING=b;TYPE=JPEG:${photo}\n ${photo}\nEND:VCARD`,
      } },
      messageTimestamp: now(),
    }]);

    const [loc, card] = received;
    expect(loc.text.split("\n")).toHaveLength(1);
    expect(loc.text).toContain("lat=1.5 lng=2");
    expect(card.text).toContain("TEL;type=CELL:+1 555 0100");
    expect(card.text).not.toContain("PHOTO");
    expect(card.text.length).toBeLessThan(500);
  });
});
