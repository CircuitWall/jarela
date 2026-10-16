/**
 * WhatsApp click-to-chat link for a Baileys JID.
 *
 * WhatsApp has no permalink to a group or to a single message, so only 1:1
 * chats with a phone-number JID get a link: `https://wa.me/<digits>` opens
 * that chat in the WhatsApp app or WhatsApp Web. `@lid` ids hide the phone
 * number, and groups, channels and broadcasts have no public chat URL.
 */

// E.164 numbers are at most 15 digits; the shortest real ones are 7–8.
const E164_DIGITS = /^[1-9]\d{6,14}$/;

export function whatsappChatLink(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const at = jid.lastIndexOf("@");
  if (at < 0) return null;
  const host = jid.slice(at + 1);
  if (host !== "s.whatsapp.net" && host !== "c.us") return null;
  const digits = jid.slice(0, at).split(":")[0];
  return E164_DIGITS.test(digits) ? `https://wa.me/${digits}` : null;
}
