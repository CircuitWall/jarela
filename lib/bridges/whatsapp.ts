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
 *    !fromMe are forwarded to the inbound handler as plain-text only —
 *    media (image/audio/voice/sticker/document) are silently dropped in v1.
 *  - `stop()` closes the WS without wiping auth.
 *  - `resetAuth()` removes the auth dir on disk; the next `start()` will
 *    fall into pairing mode again.
 */

import { ensureBridgeAuthDir, removeBridgeAuthDir } from "@/lib/stores/bridges";
import type { BridgeAdapter, InboundHandler, StatusHandler, InboundMessage, StatusUpdate } from "./types";

// Baileys + qrcode are dev-time-installed peer libs. We never import their
// types directly — both modules are loaded via dynamic `import()` inside
// start() and treated as opaque values shaped by `UnsafeBaileys` below.
// That keeps `next build` healthy even on a fresh clone where the packages
// haven't been installed yet, and protects us against minor API drift in
// future Baileys releases without dragging the whole file into ts errors.

type WASocket = {
  ev: { on: (event: string, handler: (...args: unknown[]) => void) => void };
  user?: { id?: string };
  sendMessage: (jid: string, content: { text: string }) => Promise<unknown>;
  end?: (err: Error | undefined) => void;
};

interface UnsafeBaileys {
  default: (opts: Record<string, unknown>) => WASocket;
  useMultiFileAuthState: (dir: string) => Promise<{ state: unknown; saveCreds: () => Promise<void> }>;
  fetchLatestBaileysVersion: () => Promise<{ version: [number, number, number] }>;
  DisconnectReason: Record<string, number>;
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
      // `Browsers` helpers produce identifiers WhatsApp accepts.
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
          key?: { remoteJid?: string; fromMe?: boolean; id?: string };
          pushName?: string;
          message?: {
            conversation?: string;
            extendedTextMessage?: { text?: string };
          };
        };
        if (!m.key?.remoteJid || m.key.fromMe) continue;
        const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? "";
        if (!text) continue; // drop non-text in v1
        const remote_jid = m.key.remoteJid;
        const inbound: InboundMessage = {
          remote_jid,
          push_name: m.pushName ?? null,
          text,
          message_id: m.key.id ?? null,
          is_group: remote_jid.endsWith("@g.us"),
        };
        if (this.inboundHandler) {
          try { await this.inboundHandler(inbound); }
          catch (err) {
            console.error(`[bridge ${this.bridge_id}] inbound handler threw:`, err);
          }
        }
      }
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const sock = this.sock;
    this.sock = null;
    if (!sock) return;
    try {
      // logout() also wipes server-side auth — we just want to close the
      // socket and leave creds on disk intact. `end()` is the right call.
      (sock as unknown as { end?: (err: Error | undefined) => void }).end?.(undefined);
    } catch { /* ignore */ }
    this.pushStatus({ status: "disconnected", qr_data_url: null, error: null });
  }

  async sendText(remote_jid: string, text: string): Promise<void> {
    const sock = this.sock;
    if (!sock) throw new Error("Bridge not connected");
    await (sock as unknown as { sendMessage: (jid: string, content: { text: string }) => Promise<unknown> })
      .sendMessage(remote_jid, { text });
  }

  async resetAuth(): Promise<void> {
    await this.stop();
    removeBridgeAuthDir(this.bridge_id);
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
