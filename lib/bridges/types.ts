/**
 * BridgeAdapter — protocol contract every channel implementation must satisfy.
 *
 * The runtime (`lib/bridges/runtime.ts`) owns the lifecycle (start/stop on
 * boot, on enable/disable, on re-pair); the dispatcher (`lib/bridges/dispatcher.ts`)
 * owns the inbound flow (resolve route → run agent → send reply). Concrete
 * adapters (WhatsApp via Baileys today; future Telegram/Slack/Discord)
 * implement this interface.
 *
 * v1 ships only the WhatsApp adapter — the interface is here so that adding
 * a second channel doesn't require touching `dispatcher.ts` or `runtime.ts`.
 */

export type BridgeStatus = "disconnected" | "pairing" | "connected" | "error";

export interface InboundMessage {
  /** The remote chat identifier the adapter speaks (Baileys JID for WhatsApp). */
  remote_jid: string;
  /** Best-effort human-readable label captured at receive time (push_name, contact display, etc.). */
  push_name: string | null;
  /** Plain text body. Adapters drop non-text messages (media, voice) silently in v1. */
  text: string;
  /** Adapter-specific message id (used for de-dup on adapter restart). */
  message_id: string | null;
  /** Whether the chat is a group (informational only — routing is by JID either way). */
  is_group: boolean;
}

export interface StatusUpdate {
  status: BridgeStatus;
  /** Base64 data URL when status='pairing' (and the adapter has produced a fresh QR). */
  qr_data_url?: string | null;
  /** Human-readable error when status='error'. */
  error?: string | null;
  /** Remote-account identifier once paired (e.g. WhatsApp phone JID, "+15551234@s.whatsapp.net"). */
  paired_id?: string | null;
}

export type InboundHandler = (msg: InboundMessage) => void | Promise<void>;
export type StatusHandler = (update: StatusUpdate) => void;

/**
 * One chat known to the adapter. Populated from history sync, observed
 * inbound messages, and on-demand group metadata fetches. Used to power the
 * chat-picker in the UI so users don't have to know their JIDs.
 */
export interface ChatInfo {
  remote_jid: string;
  /** Best-effort name (contact display name, group subject, or push_name fallback). */
  name: string | null;
  is_group: boolean;
  /** Unix ms of last observed activity (for ordering). null = never seen a message. */
  last_message_at: number | null;
}

export interface BridgeAdapter {
  /** Bridge row id (so handlers can correlate). */
  readonly bridge_id: string;
  /** Idempotent — calling twice is a no-op. */
  start(): Promise<void>;
  /** Idempotent — calling twice is a no-op. Releases the underlying connection. */
  stop(): Promise<void>;
  /** Send a plain-text reply on this channel. Throws on transport error. */
  sendText(remote_jid: string, text: string): Promise<void>;
  /**
   * Show/hide a "typing…" indicator on the channel while the agent is
   * processing the message. Best-effort — adapters whose transports
   * don't support presence may no-op. Errors are swallowed by the caller.
   */
  sendTyping(remote_jid: string, typing: boolean): Promise<void>;
  /** Wipe auth state on disk and force re-pair on next start. */
  resetAuth(): Promise<void>;
  /** Register handlers. Must be called BEFORE start(). */
  onInboundMessage(handler: InboundHandler): void;
  onStatusChange(handler: StatusHandler): void;
  /**
   * Snapshot of chats the adapter has observed since connecting. Returns
   * an empty array if the adapter isn't connected or hasn't synced yet.
   */
  listChats(): ChatInfo[];
  /**
   * Refresh the chat list on demand (e.g. fetch group metadata). Optional —
   * adapters that have no out-of-band way to enumerate chats may no-op.
   */
  refreshChats(): Promise<void>;
  /**
   * Verify a freeform user input (typically a phone number) maps to a
   * chat on this channel and return its ChatInfo. Returns null if the
   * input doesn't resolve to a real account. Used by the UI's "find by
   * phone" search so users can route to a 1:1 chat that hasn't synced
   * via history yet.
   */
  lookupChat(input: string): Promise<ChatInfo | null>;
}
