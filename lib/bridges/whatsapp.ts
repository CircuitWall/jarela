/**
 * Baileys WhatsApp adapter.
 *
 * Pure-Node WebSocket client speaking WhatsApp's Multi-Device protocol. No
 * Chromium, no public URL needed. Pairs via QR code shown in the UI.
 *
 * Lifecycle:
 *  - `start()` boots the socket. Baileys auto-resumes from auth state on
 *    disk if present (no re-pair); otherwise it emits a QR string, which
 *    we convert to a data URL and surface via `onStatusChange`.
 *  - `connection.update` events drive our status reporter
 *    (`disconnected | pairing | connected | error`).
 *  - `messages.upsert` events with `type='notify'` (real-time inbound) and
 *    !fromMe are forwarded to the inbound handler. Text, captions, images
 *    (vision), stickers (as webp images), voice notes / audio, video, and
 *    documents are all extracted via `extractContent`; location and contact
 *    payloads are flattened into the text body. Reactions, polls and other
 *    protocol-only messages are silently dropped.
 *  - `stop()` closes the WS without wiping auth.
 *  - `resetAuth()` removes the auth dir on disk; the next `start()` will
 *    fall into pairing mode again.
 */

import { ensureBridgeAuthDir, findRoute, removeBridgeAuthDir } from "@/lib/stores/bridges";
import type { BridgeAdapter, ChatInfo, InboundHandler, StatusHandler, InboundMessage, StatusUpdate } from "./types";
import type { ContentPart } from "@/lib/tools/types";

// Baileys + qrcode are dev-time-installed peer libs. We never import their
// types directly — both modules are loaded via dynamic `import()` inside
// start() and treated as opaque values shaped by `UnsafeBaileys` below.
// That keeps `next build` healthy even on a fresh clone where the packages
// haven't been installed yet, and protects us against minor API drift in
// future Baileys releases without dragging the whole file into ts errors.

type WASocket = {
  ev: { on: (event: string, handler: (...args: unknown[]) => void) => void };
  user?: { id?: string };
  sendMessage: (
    jid: string,
    content: { text: string },
    options?: { getUrlInfo?: undefined },
  ) => Promise<unknown>;
  sendPresenceUpdate?: (presence: string, jid?: string) => Promise<unknown>;
  presenceSubscribe?: (jid: string) => Promise<unknown>;
  end?: (err: Error | undefined) => void;
  groupFetchAllParticipating?: () => Promise<Record<string, { id: string; subject?: string }>>;
  onWhatsApp?: (...jids: string[]) => Promise<Array<{ jid?: string; exists?: boolean; lid?: string }>>;
  updateMediaMessage?: (msg: unknown) => Promise<unknown>;
};

interface UnsafeBaileys {
  default: (opts: Record<string, unknown>) => WASocket;
  useMultiFileAuthState: (dir: string) => Promise<{ state: unknown; saveCreds: () => Promise<void> }>;
  fetchLatestBaileysVersion: () => Promise<{ version: [number, number, number] }>;
  DisconnectReason: Record<string, number>;
  downloadMediaMessage: (
    message: unknown,
    type: "buffer" | "stream",
    options: Record<string, unknown>,
    ctx?: { logger?: unknown; reuploadRequest?: (msg: unknown) => Promise<unknown> },
  ) => Promise<Buffer>;
  Browsers: {
    ubuntu: (browser: string) => [string, string, string];
    macOS: (browser: string) => [string, string, string];
    windows: (browser: string) => [string, string, string];
    appropriate: (browser: string) => [string, string, string];
  };
}

export class WhatsAppBridgeAdapter implements BridgeAdapter {
  readonly bridge_id: string;
  private sock: WASocket | null = null;
  private inboundHandler: InboundHandler | null = null;
  private statusHandler: StatusHandler | null = null;
  private stopping = false;
  private currentStatus: StatusUpdate["status"] = "disconnected";
  // Chats observed since this adapter connected. Populated from
  // messaging-history.set (initial sync), chats.upsert/update, contacts
  // upsert (for display names), and observed messages. Cleared on disconnect.
  private chats = new Map<string, ChatInfo>();
  // The paired account's own JID (normalized, no device suffix). Set on
  // connection — used to recognize the self-chat so messages the user sends
  // to themselves can route to an agent.
  private selfJid: string | null = null;
  // IDs of messages we sent via sendText. WhatsApp echoes these back as
  // `fromMe` upserts; without this filter we'd loop on our own replies in
  // the self-chat. Bounded ring (most recent N).
  private sentIds: string[] = [];
  private sentIdsSet = new Set<string>();
  private static readonly SENT_IDS_MAX = 500;
  /**
   * Cap on per-attachment payload size we'll forward to the LLM. WhatsApp
   * compresses images to a few hundred KB; voice notes / short videos
   * usually sit well under this too. The cap mainly exists so a deliberately
   * crafted huge file (or a wallpaper-sized JPEG, or a 30-min video) doesn't
   * blow the agent's request budget. 8 MB raw ≈ ~11 MB base64 inline.
   */
  private static readonly MAX_MEDIA_BYTES = 8 * 1024 * 1024;

  constructor(bridge_id: string) {
    this.bridge_id = bridge_id;
  }

  onInboundMessage(handler: InboundHandler): void { this.inboundHandler = handler; }
  onStatusChange(handler: StatusHandler): void { this.statusHandler = handler; }

  async start(): Promise<void> {
    if (this.sock) return;
    this.stopping = false;

    // Dynamically import — see comment at top of file.
    let baileys: UnsafeBaileys;
    let qrcode: typeof import("qrcode");
    try {
      baileys = (await import("baileys")) as unknown as UnsafeBaileys;
      qrcode = await import("qrcode");
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.pushStatus({ status: "error", error: `Baileys not installed: ${m}` });
      throw err;
    }

    const authDir = ensureBridgeAuthDir(this.bridge_id);
    const { state, saveCreds } = await baileys.useMultiFileAuthState(authDir);

    let version: [number, number, number] | undefined;
    try {
      const v = await baileys.fetchLatestBaileysVersion();
      version = v.version;
    } catch {
      // Network blip during boot — Baileys will fall back to its bundled
      // version constant. Not fatal.
    }

    const sock = baileys.default({
      auth: state,
      version,
      // Quiet the embedded pino logger — we surface the meaningful events
      // (status, errors) via our own logging.
      logger: makeSilentLogger(),
      // IMPORTANT: WhatsApp validates the browser identifier during link-
      // device pairing and rejects unrecognized tuples with the misleading
      // "Check your phone connection and try again" error on the phone
      // (even though the WS connection itself is fine). The Baileys-shipped
      // `Browsers` helpers produce identifiers WhatsApp accepts. We tried
      // swapping the middle slot to "Jarela" once for branding in the
      // linked-devices list — WhatsApp rejected pairing. Keep "Chrome".
      browser: baileys.Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (...args: unknown[]) => {
      const u = (args[0] ?? {}) as Record<string, unknown>;
      const conn = u.connection as string | undefined;
      const qr = u.qr as string | undefined;
      const lastDisconnect = u.lastDisconnect as
        | { error?: { output?: { statusCode?: number }; message?: string } }
        | undefined;

      if (qr) {
        try {
          const dataUrl = await qrcode.toDataURL(qr);
          this.pushStatus({ status: "pairing", qr_data_url: dataUrl, error: null });
        } catch {
          // QR encoding failed — fall back to raw string (UI can render it
          // via any QR component) by skipping data URL.
          this.pushStatus({ status: "pairing", qr_data_url: qr, error: null });
        }
      }

      if (conn === "open") {
        const me = (sock as unknown as { user?: { id?: string } }).user?.id ?? null;
        this.pushStatus({
          status: "connected",
          qr_data_url: null,
          error: null,
          paired_id: me,
        });
        // Pin the user's own number into the chat cache so "Message yourself"
        // is always pickable in the route editor — handy for testing a route
        // without needing a second WhatsApp account. The paired_id we get
        // from Baileys can include a device suffix (":NN") that's stripped
        // here to produce a routable @s.whatsapp.net JID.
        if (me) {
          const selfJid = normalizeUserJid(me);
          this.selfJid = selfJid;
          if (selfJid) this.observeChat(selfJid, "Yourself", null);
        }
        // Kick off a background fetch of group metadata so the picker has
        // names for joined groups even before any message arrives. Personal
        // chats trickle in via messaging-history.set + chats.upsert.
        void this.refreshChats().catch(() => { /* best-effort */ });
      } else if (conn === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === baileys.DisconnectReason?.loggedOut;

        if (this.stopping) {
          this.pushStatus({ status: "disconnected", qr_data_url: null, error: null });
          return;
        }
        if (loggedOut) {
          this.pushStatus({
            status: "error",
            qr_data_url: null,
            error: "Logged out — auth invalidated by remote. Re-pair required.",
          });
          // Don't auto-reconnect on logout; the user has to re-pair.
          this.sock = null;
          return;
        }
        // Otherwise: transient disconnect. Reconnect with simple backoff.
        const reason = lastDisconnect?.error?.message ?? `code=${code}`;
        this.pushStatus({ status: "error", qr_data_url: null, error: `Disconnected: ${reason}` });
        this.sock = null;
        setTimeout(() => {
          if (!this.stopping) {
            void this.start().catch((e) => {
              console.error(`[bridge ${this.bridge_id}] reconnect failed:`, e);
            });
          }
        }, 5_000).unref?.();
      }
    });

    sock.ev.on("messages.upsert", async (...args: unknown[]) => {
      const payload = (args[0] ?? {}) as { messages?: unknown[]; type?: string };
      if (payload.type !== "notify") return; // ignore history/append
      for (const raw of payload.messages ?? []) {
        const m = raw as {
          key?: { remoteJid?: string; remoteJidAlt?: string; fromMe?: boolean; id?: string; participant?: string };
          pushName?: string;
          message?: WAMessageContent;
          messageTimestamp?: number | { low?: number };
        };
        if (!m.key?.remoteJid) continue;
        if (m.key.fromMe) {
          // Allow `fromMe` ONLY in the self-chat (you DMing yourself), so the
          // "Yourself" route can fire without a second WhatsApp account.
          // Skip our own bot replies (sendText records their IDs) and any
          // `fromMe` traffic in other chats (those echoes would loop).
          const candidate = pickRoutableJid(m.key.remoteJid, m.key.remoteJidAlt);
          const isSelfChat = !!this.selfJid && candidate === this.selfJid;
          if (!isSelfChat) continue;
          if (m.key.id && this.sentIdsSet.has(m.key.id)) continue;
        }
        // Baileys 7 / modern WhatsApp delivers many personal chats with a
        // `@lid` ("Local IDentifier") remoteJid instead of `@s.whatsapp.net`.
        // The chat picker filters those out (they aren't valid sendMessage
        // targets), so saved routes are keyed on the `@s.whatsapp.net` form.
        // To make routing actually match, prefer `remoteJidAlt` when it
        // points at a routable JID — that's the same chat in its
        // phone-number form.
        const remote_jid = pickRoutableJid(m.key.remoteJid, m.key.remoteJidAlt);
        const is_group = remote_jid.endsWith("@g.us");
        // Update the chat cache regardless of payload shape — the chat is
        // "real" the moment we see any message from it, even one whose
        // body we end up unable to represent (e.g. reactions, polls).
        const ts = typeof m.messageTimestamp === "number"
          ? m.messageTimestamp * 1000
          : (m.messageTimestamp?.low ?? 0) * 1000 || Date.now();
        // In groups, pushName is typically the participant's display name,
        // not the group subject. Avoid poisoning the group chat label.
        this.observeChat(remote_jid, is_group ? null : (m.pushName ?? null), ts);

        // Unwrap protocol envelopes (view-once, ephemeral, etc.) so we can
        // see the underlying payload uniformly, then turn it into a text
        // body + ContentPart attachments the agent can consume.
        const inner = unwrapMessage(m.message);
        const { text, attachments } = await this.extractContent(inner, m, baileys, sock, remote_jid);

        // Drop messages we can't represent at all (e.g. protocol/system
        // notices, reactions, unsupported message types).
        if (!text && attachments.length === 0) continue;
        // In group chats `key.participant` is the actual sender's JID
        // (the chat-level remote_jid is the group, not the person). In 1:1
        // chats it's undefined — the sender == remote_jid. Normalize so the
        // dispatcher gets a routable user JID, not the legacy @c.us form.
        const participant_jid = is_group && m.key.participant
          ? normalizeUserJid(m.key.participant)
          : null;
        const chat_name = this.chats.get(remote_jid)?.name ?? m.pushName ?? null;
        const sender_name = participant_jid
          ? (this.chats.get(participant_jid)?.name ?? m.pushName ?? participant_jid)
          : (m.pushName ?? chat_name);
        const inbound: InboundMessage = {
          remote_jid,
          push_name: m.pushName ?? null,
          chat_name,
          sender_name,
          text,
          attachments: attachments.length ? attachments : undefined,
          message_id: m.key.id ?? null,
          is_group,
          participant_jid,
        };
        if (this.inboundHandler) {
          try { await this.inboundHandler(inbound); }
          catch (err) {
            console.error(`[bridge ${this.bridge_id}] inbound handler threw:`, err);
          }
        }
      }
    });

    // ---- Chat cache: populated from history sync + live chat/contact events ----
    //
    // `messaging-history.set` carries the recent chats Baileys received
    // during the initial sync. `chats.upsert` / `chats.update` fire for
    // brand-new chats and metadata changes. `contacts.upsert` gives us
    // display names for personal contacts.
    sock.ev.on("messaging-history.set", (...args: unknown[]) => {
      const payload = (args[0] ?? {}) as { chats?: unknown[]; contacts?: unknown[] };
      for (const raw of payload.chats ?? []) {
        const c = raw as { id?: string; name?: string; conversationTimestamp?: number };
        if (!c.id) continue;
        const ts = c.conversationTimestamp ? c.conversationTimestamp * 1000 : null;
        this.observeChat(c.id, c.name ?? null, ts);
      }
      for (const raw of payload.contacts ?? []) {
        const ct = raw as { id?: string; name?: string; notify?: string; verifiedName?: string };
        if (!ct.id) continue;
        const name = ct.name ?? ct.verifiedName ?? ct.notify ?? null;
        // Only register a chat if the contact id looks like a chat JID
        // (skip the user's own LID/PN noise). @s.whatsapp.net / @g.us only.
        if (ct.id.endsWith("@s.whatsapp.net") || ct.id.endsWith("@g.us")) {
          this.observeChat(ct.id, name, null);
        } else {
          // Still keep the display name handy in case we see this contact
          // from a different JID shape later — but don't surface non-chat
          // JIDs in the picker.
        }
      }
    });

    sock.ev.on("chats.upsert", (...args: unknown[]) => {
      const list = (args[0] ?? []) as Array<{ id?: string; name?: string; conversationTimestamp?: number }>;
      for (const c of list) {
        if (!c.id) continue;
        const ts = c.conversationTimestamp ? c.conversationTimestamp * 1000 : null;
        this.observeChat(c.id, c.name ?? null, ts);
      }
    });

    sock.ev.on("chats.update", (...args: unknown[]) => {
      const list = (args[0] ?? []) as Array<{ id?: string; name?: string; conversationTimestamp?: number }>;
      for (const c of list) {
        if (!c.id) continue;
        const ts = c.conversationTimestamp ? c.conversationTimestamp * 1000 : null;
        this.observeChat(c.id, c.name ?? null, ts);
      }
    });

    sock.ev.on("contacts.upsert", (...args: unknown[]) => {
      const list = (args[0] ?? []) as Array<{ id?: string; name?: string; notify?: string; verifiedName?: string }>;
      for (const ct of list) {
        if (!ct.id) continue;
        if (!(ct.id.endsWith("@s.whatsapp.net") || ct.id.endsWith("@g.us"))) continue;
        this.observeChat(ct.id, ct.name ?? ct.verifiedName ?? ct.notify ?? null, null);
      }
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const sock = this.sock;
    this.sock = null;
    this.chats.clear();
    this.selfJid = null;
    this.sentIds = [];
    this.sentIdsSet.clear();
    if (!sock) return;
    try {
      // logout() also wipes server-side auth — we just want to close the
      // socket and leave creds on disk intact. `end()` is the right call.
      (sock as unknown as { end?: (err: Error | undefined) => void }).end?.(undefined);
    } catch { /* ignore */ }
    this.pushStatus({ status: "disconnected", qr_data_url: null, error: null });
  }

  async sendText(remote_jid: string, text: string): Promise<void> {
    // Hard guard: refuse to send to any chat whose route is in silent_mode.
    // The dispatcher already short-circuits before calling sendText, but
    // we re-check here so that *any* future code path that gets hold of an
    // adapter instance (agent tools, plugins, debug shells, scheduled jobs)
    // cannot bypass the user's silent-mode choice. The route table is the
    // single source of truth — one synchronous SQLite lookup per send is
    // cheap and avoids stale-cache bugs.
    const route = findRoute(this.bridge_id, remote_jid);
    if (route?.silent_mode === 1) {
      console.warn(
        `[bridge ${this.bridge_id}] sendText blocked: route ${route.id} (${remote_jid}) is in silent_mode`,
      );
      return;
    }
    const sock = this.sock;
    if (!sock) throw new Error("Bridge not connected");
    const result = await (
      sock as unknown as {
        sendMessage: (
          jid: string,
          content: { text: string },
          options?: { getUrlInfo?: undefined },
        ) => Promise<unknown>;
      }
    ).sendMessage(
      remote_jid,
      { text },
      // Security hardening: prevent Baileys from invoking link-preview-js URL
      // fetches for outbound text messages (SSRF/loopback class risks).
      { getUrlInfo: undefined },
    );
    // Record the outgoing message ID so the matching `fromMe` echo from
    // messages.upsert doesn't re-enter the routing pipeline in the self-chat.
    const sentId = (result as { key?: { id?: string } } | null | undefined)?.key?.id;
    if (sentId) this.rememberSentId(sentId);
  }

  private rememberSentId(id: string): void {
    if (this.sentIdsSet.has(id)) return;
    this.sentIds.push(id);
    this.sentIdsSet.add(id);
    while (this.sentIds.length > WhatsAppBridgeAdapter.SENT_IDS_MAX) {
      const evict = this.sentIds.shift();
      if (evict) this.sentIdsSet.delete(evict);
    }
  }

  async sendTyping(remote_jid: string, typing: boolean): Promise<void> {
    // Hard guard: typing/composing is an outbound signal — suppress on
    // silent_mode routes for the same reason as sendText.
    if (typing) {
      const route = findRoute(this.bridge_id, remote_jid);
      if (route?.silent_mode === 1) return;
    }
    const sock = this.sock;
    if (!sock?.sendPresenceUpdate) return;
    // Subscribing makes WhatsApp deliver presence both ways — not strictly
    // required for sending our composing state, but cheap and keeps the
    // session consistent. Errors are best-effort.
    try {
      if (typing && sock.presenceSubscribe) {
        await sock.presenceSubscribe(remote_jid).catch(() => { /* best-effort */ });
      }
      await sock.sendPresenceUpdate(typing ? "composing" : "paused", remote_jid);
    } catch (err) {
      // Don't let presence hiccups break the reply path — just log.
      console.warn(`[bridge ${this.bridge_id}] sendPresenceUpdate failed:`, err);
    }
  }

  async resetAuth(): Promise<void> {
    await this.stop();
    removeBridgeAuthDir(this.bridge_id);
  }

  listChats(): ChatInfo[] {
    // Only chats whose JID is a routable chat (1:1 or group). Status JIDs
    // (broadcast lists, statuses, "@broadcast", "@lid", "@s.whatsapp.net:0")
    // are filtered out — none of them are valid sendMessage targets.
    const out: ChatInfo[] = [];
    for (const c of this.chats.values()) {
      if (c.remote_jid.endsWith("@s.whatsapp.net") || c.remote_jid.endsWith("@g.us")) {
        out.push(c);
      }
    }
    // Newest activity first; chats we've never seen a message from go last,
    // alphabetically by name so the picker is stable.
    out.sort((a, b) => {
      const ta = a.last_message_at ?? 0;
      const tb = b.last_message_at ?? 0;
      if (ta !== tb) return tb - ta;
      return (a.name ?? a.remote_jid).localeCompare(b.name ?? b.remote_jid);
    });
    return out;
  }

  async refreshChats(): Promise<void> {
    const sock = this.sock;
    if (!sock?.groupFetchAllParticipating) return;
    try {
      const groups = await sock.groupFetchAllParticipating();
      for (const g of Object.values(groups)) {
        if (!g?.id) continue;
        this.observeChat(g.id, g.subject ?? null, null);
      }
    } catch (err) {
      // Group enumeration is best-effort — a transient WS hiccup shouldn't
      // poison anything.
      console.warn(`[bridge ${this.bridge_id}] groupFetchAllParticipating failed:`, err);
    }
  }

  async lookupChat(input: string): Promise<ChatInfo | null> {
    const sock = this.sock;
    if (!sock?.onWhatsApp) return null;
    const digits = normalizePhoneDigits(input);
    if (digits.length < 6) return null; // refuse obviously-bogus short numbers
    try {
      const results = await sock.onWhatsApp(digits);
      const hit = results?.find((r) => r?.exists && r.jid);
      if (!hit?.jid) return null;
      // Add it to our chat cache so the UI's polling pass picks it up too.
      this.observeChat(hit.jid, null, null);
      return {
        remote_jid: hit.jid,
        name: null,
        is_group: hit.jid.endsWith("@g.us"),
        last_message_at: null,
      };
    } catch (err) {
      console.warn(`[bridge ${this.bridge_id}] onWhatsApp lookup failed:`, err);
      return null;
    }
  }

  /**
   * Extract a routable text body + ContentPart attachments from one inbound
   * WhatsApp message. Handles every common payload type:
   *   - imageMessage          → image ContentPart (vision input)
   *   - stickerMessage        → image ContentPart (webp; vision input)
   *   - audioMessage / PTT    → file ContentPart with audio/* mime
   *   - videoMessage          → file ContentPart with video/* mime
   *   - documentMessage       → file ContentPart (utf-8 text for text/*+json,
   *                             base64 for everything else)
   *   - location / liveLoc    → inline text "[location: lat,lng ...]"
   *   - contactMessage(s)     → inline text with the vcard / display names
   *
   * Each download is independent — a failure on one attachment doesn't lose
   * the caption text or other attachments. Anything we can't represent
   * leaves both fields empty and the upsert loop drops the message.
   */
  private async extractContent(
    inner: WAMessageContent | undefined,
    rawMessage: unknown,
    baileys: UnsafeBaileys,
    sock: WASocket,
    remote_jid: string,
  ): Promise<{ text: string; attachments: ContentPart[] }> {
    const attachments: ContentPart[] = [];
    let text =
      inner?.conversation
      ?? inner?.extendedTextMessage?.text
      ?? inner?.imageMessage?.caption
      ?? inner?.videoMessage?.caption
      ?? inner?.documentMessage?.caption
      ?? "";
    if (!inner) return { text, attachments };

    // Baileys' downloadMediaMessage expects the *outer* upsert message
    // (with `.key` + `.message`), not the inner part. Wrap the per-kind
    // download here so the loop body stays declarative.
    const download = async (label: string): Promise<Buffer | null> => {
      try {
        const buf = await baileys.downloadMediaMessage(
          rawMessage,
          "buffer",
          {},
          {
            logger: makeSilentLogger(),
            reuploadRequest: sock.updateMediaMessage?.bind(sock),
          },
        );
        if (!buf || buf.length === 0) return null;
        if (buf.length > WhatsAppBridgeAdapter.MAX_MEDIA_BYTES) {
          console.warn(
            `[bridge ${this.bridge_id}] dropped oversize ${label} (${buf.length} bytes) from ${remote_jid}`,
          );
          return null;
        }
        return buf;
      } catch (err) {
        // Media decryption / network errors are non-fatal — fall through
        // so the caption (if any) and other parts still reach the agent.
        const m = err instanceof Error ? err.message : String(err);
        console.warn(`[bridge ${this.bridge_id}] ${label} download failed for ${remote_jid}: ${m}`);
        return null;
      }
    };

    if (inner.imageMessage) {
      const buf = await download("image");
      if (buf) {
        attachments.push({
          type: "image",
          media_type: sanitizeMediaType(inner.imageMessage.mimetype, "image", "image/jpeg"),
          data: buf.toString("base64"),
        });
      }
    }

    if (inner.stickerMessage) {
      const buf = await download("sticker");
      if (buf) {
        // Stickers are webp images — surfacing them as `image` lets vision
        // models actually describe them. Animated stickers go through as
        // their raw webp; providers that can't decode animated webp will
        // typically render the first frame.
        attachments.push({
          type: "image",
          media_type: sanitizeMediaType(inner.stickerMessage.mimetype, "image", "image/webp"),
          data: buf.toString("base64"),
        });
      }
    }

    if (inner.audioMessage) {
      const isVoice = !!inner.audioMessage.ptt;
      const buf = await download(isVoice ? "voice" : "audio");
      if (buf) {
        attachments.push({
          type: "file",
          name: isVoice ? "voice-note" : "audio",
          media_type: sanitizeMediaType(inner.audioMessage.mimetype, "audio", "audio/ogg"),
          data: buf.toString("base64"),
        });
      }
    }

    if (inner.videoMessage) {
      const buf = await download("video");
      if (buf) {
        attachments.push({
          type: "file",
          name: "video",
          media_type: sanitizeMediaType(inner.videoMessage.mimetype, "video", "video/mp4"),
          data: buf.toString("base64"),
        });
      }
    }

    if (inner.documentMessage) {
      const buf = await download("document");
      if (buf) {
        const mime = sanitizeMediaType(
          inner.documentMessage.mimetype,
          "document",
          "application/octet-stream",
        );
        // The LLM layer (lib/agents/llm.ts) inlines text/* and
        // application/json file parts directly as their `data` string. For
        // those we must store the decoded UTF-8 contents, not base64.
        const inlineAsText = mime.startsWith("text/") || mime === "application/json";
        attachments.push({
          type: "file",
          name: inner.documentMessage.fileName || inner.documentMessage.title || "document",
          media_type: mime,
          data: inlineAsText ? buf.toString("utf8") : buf.toString("base64"),
        });
      }
    }

    if (inner.locationMessage) {
      const { degreesLatitude, degreesLongitude, name, address } = inner.locationMessage;
      const parts = [`lat=${degreesLatitude ?? "?"}`, `lng=${degreesLongitude ?? "?"}`];
      if (name) parts.push(`name="${name}"`);
      if (address) parts.push(`address="${address}"`);
      text = (text ? text + "\n" : "") + `[location: ${parts.join(" ")}]`;
    }

    if (inner.liveLocationMessage) {
      const { degreesLatitude, degreesLongitude } = inner.liveLocationMessage;
      text = (text ? text + "\n" : "") + `[live-location: lat=${degreesLatitude ?? "?"} lng=${degreesLongitude ?? "?"}]`;
    }

    if (inner.contactMessage) {
      const name = inner.contactMessage.displayName ?? "unknown";
      const vcard = inner.contactMessage.vcard ?? "";
      text = (text ? text + "\n" : "") + `[contact: ${name}]\n${vcard}`;
    }

    if (inner.contactsArrayMessage) {
      const names = (inner.contactsArrayMessage.contacts ?? [])
        .map((c) => c?.displayName ?? "unknown")
        .join(", ");
      text = (text ? text + "\n" : "") + `[contacts: ${names}]`;
    }

    return { text, attachments };
  }

  private observeChat(remote_jid: string, name: string | null, ts: number | null): void {
    if (!remote_jid) return;
    const existing = this.chats.get(remote_jid);
    // Prefer the most recently-observed name (group subjects rename; users
    // change push names). Don't overwrite a known name with null.
    const nextName = name ?? existing?.name ?? null;
    const nextTs = ts && (!existing?.last_message_at || ts > existing.last_message_at)
      ? ts
      : existing?.last_message_at ?? null;
    this.chats.set(remote_jid, {
      remote_jid,
      name: nextName,
      is_group: remote_jid.endsWith("@g.us"),
      last_message_at: nextTs,
    });
  }

  private pushStatus(u: StatusUpdate): void {
    this.currentStatus = u.status;
    this.statusHandler?.(u);
  }

  get status(): StatusUpdate["status"] { return this.currentStatus; }
}

// Minimal pino-compatible silent logger. Baileys uses `logger.child()`
// chaining internally, so we return ourselves for every child call.
function makeSilentLogger(): unknown {
  const noop = () => { /* no-op */ };
  const self: Record<string, unknown> = {
    level: "silent",
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
  };
  self.child = () => self;
  return self;
}

// Defence against an attacker-controlled sender stuffing a hostile
// mimetype (e.g. `text/html; charset=...<script>`) into an inbound
// WhatsApp message and having it surface unsanitised in our chat UI's
// data-URL or in a downstream LLM provider call. We pin each media kind
// to a small allowlist and fall back to the canonical default whenever
// the sender's claimed type is unknown or syntactically suspicious.
const MEDIA_TYPE_ALLOWLIST: Record<"image" | "audio" | "video" | "document", ReadonlySet<string>> = {
  image: new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"]),
  audio: new Set(["audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/webm", "audio/wav", "audio/x-wav", "audio/3gpp"]),
  video: new Set(["video/mp4", "video/webm", "video/quicktime", "video/3gpp"]),
  // Documents: we keep the generic catch-all plus a handful of common
  // office/text types so the UI can hint at the right viewer. Anything
  // unrecognised collapses to application/octet-stream.
  document: new Set([
    "application/octet-stream",
    "application/pdf",
    "application/zip",
    "application/json",
    "application/xml",
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
    "text/csv",
    "text/markdown",
    "text/html",
  ]),
};

function sanitizeMediaType(
  raw: string | undefined,
  kind: "image" | "audio" | "video" | "document",
  fallback: string,
): string {
  if (!raw || typeof raw !== "string") return fallback;
  // Strip parameters (`image/jpeg; charset=...`), lowercase, trim.
  const base = raw.split(";")[0].trim().toLowerCase();
  // Reject anything that doesn't look like a bare RFC 6838 type/subtype.
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base)) return fallback;
  return MEDIA_TYPE_ALLOWLIST[kind].has(base) ? base : fallback;
}

/**
 * Subset of Baileys' WAMessageContent we look at. WhatsApp wraps payloads
 * in several envelope variants (view-once, ephemeral, V2 versions); see
 * `unwrapMessage` for how we collapse them.
 */
type WAMessageContent = {
  conversation?: string;
  extendedTextMessage?: { text?: string };
  stickerMessage?: { mimetype?: string; isAnimated?: boolean };
  audioMessage?: { mimetype?: string; ptt?: boolean; seconds?: number };
  videoMessage?: { caption?: string; mimetype?: string; seconds?: number };
  documentMessage?: { caption?: string; fileName?: string; title?: string; mimetype?: string };
  locationMessage?: { degreesLatitude?: number; degreesLongitude?: number; name?: string; address?: string };
  liveLocationMessage?: { degreesLatitude?: number; degreesLongitude?: number; caption?: string };
  contactMessage?: { displayName?: string; vcard?: string };
  contactsArrayMessage?: { contacts?: Array<{ displayName?: string; vcard?: string }> };
  imageMessage?: { caption?: string; mimetype?: string };
  viewOnceMessage?: { message?: WAMessageContent };
  viewOnceMessageV2?: { message?: WAMessageContent };
  viewOnceMessageV2Extension?: { message?: WAMessageContent };
  ephemeralMessage?: { message?: WAMessageContent };
  documentWithCaptionMessage?: { message?: WAMessageContent };
};

/**
 * Collapse the various WhatsApp envelope wrappers down to the inner content
 * with the actual `imageMessage` / `conversation` / `extendedTextMessage`
 * payload. Bounded recursion — these envelopes never nest deeper than 2
 * levels in practice, but we cap at 5 as defence in depth.
 */
function unwrapMessage(msg: WAMessageContent | undefined, depth = 0): WAMessageContent | undefined {
  if (!msg || depth > 5) return msg;
  if (msg.ephemeralMessage?.message) return unwrapMessage(msg.ephemeralMessage.message, depth + 1);
  if (msg.viewOnceMessage?.message) return unwrapMessage(msg.viewOnceMessage.message, depth + 1);
  if (msg.viewOnceMessageV2?.message) return unwrapMessage(msg.viewOnceMessageV2.message, depth + 1);
  if (msg.viewOnceMessageV2Extension?.message) return unwrapMessage(msg.viewOnceMessageV2Extension.message, depth + 1);
  if (msg.documentWithCaptionMessage?.message) return unwrapMessage(msg.documentWithCaptionMessage.message, depth + 1);
  return msg;
}

/**
 * Strip everything that isn't a digit. WhatsApp identifies accounts by
 * country-code + number with no separators, no leading '+'. Accepts the
 * common human formats: "+1 (555) 123-4567", "5511 99999-0000", etc.
 */
function normalizePhoneDigits(input: string): string {
  return input.replace(/\D+/g, "");
}

/**
 * Prefer the routable JID form (`@s.whatsapp.net` or `@g.us`) over `@lid`.
 *
 * WhatsApp's privacy-preserving identifier rollout means inbound messages
 * frequently arrive with `key.remoteJid = "<id>@lid"` and the actual
 * phone-number JID in `key.remoteJidAlt`. The chat picker can only show
 * routable JIDs (you can't sendMessage to an `@lid`), so saved routes use
 * the `@s.whatsapp.net` form — without this normalization, every inbound
 * `@lid` message would silently fail to match its route.
 */
function pickRoutableJid(primary: string, alt: string | undefined): string {
  const isRoutable = (j: string | undefined) =>
    !!j && (j.endsWith("@s.whatsapp.net") || j.endsWith("@g.us"));
  if (isRoutable(primary)) return primary;
  if (isRoutable(alt)) return alt!;
  return primary;
}

/**
 * Baileys' paired_id (sock.user.id) sometimes carries a device suffix
 * like "5511999990000:23@s.whatsapp.net". Strip the suffix so we get a
 * routable user JID — `sendMessage` won't deliver to a JID with `:NN`.
 * Returns null if the input is malformed.
 */
function normalizeUserJid(id: string): string | null {
  // Strip any device suffix (":NN") before the '@'.
  const at = id.indexOf("@");
  if (at < 0) return null;
  const user = id.slice(0, at).split(":")[0];
  const host = id.slice(at + 1);
  if (!user || !host) return null;
  // WhatsApp uses @s.whatsapp.net for user accounts; in some contexts
  // Baileys exposes @c.us as a legacy alias — normalize to @s.whatsapp.net.
  const normHost = host === "c.us" ? "s.whatsapp.net" : host;
  return `${user}@${normHost}`;
}
