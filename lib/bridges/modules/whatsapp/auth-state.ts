import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "@/lib/db/data-dir";

export function whatsappAuthDir(bridgeId: string): string {
  return join(getDataDir(), "baileys", bridgeId);
}

export function ensureWhatsAppAuthDir(bridgeId: string): string {
  const dir = whatsappAuthDir(bridgeId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeWhatsAppAuth(bridgeId: string): void {
  try { rmSync(whatsappAuthDir(bridgeId), { recursive: true, force: true }); }
  catch { /* directory did not exist */ }
}