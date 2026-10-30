import { getDb } from "@/lib/db";
import { encrypt, decryptIfNeeded } from "@/lib/crypto/envelope";
import { withDbTransaction } from "@/lib/db/transaction";
import {
  AdvertisementPolicySchema, AdvertisementStateSchema, defaultAdvertisementPolicy,
  type AdvertisementPolicy, type AdvertisementState,
} from "@/lib/agents/advertisement-contract";

const NS = "agent-advertisements";
const POLICY = "agent-advertisement-policy";
export function getAdvertisementPolicy(): AdvertisementPolicy {
  const row = getDb().prepare("SELECT value FROM memory_store WHERE namespace=? AND key=?")
    .get("app-settings", POLICY) as { value: string } | undefined;
  return row ? AdvertisementPolicySchema.parse(JSON.parse(row.value)) : defaultAdvertisementPolicy();
}
export function setAdvertisementPolicy(policy: AdvertisementPolicy): void {
  const checked = AdvertisementPolicySchema.parse(policy);
  const timestamp = new Date().toISOString();
  getDb().prepare("INSERT INTO memory_store(namespace,key,value,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .run("app-settings", POLICY, JSON.stringify(checked), timestamp, timestamp);
}
export function getAdvertisement(agentId: string): AdvertisementState | null {
  const row = getDb().prepare("SELECT value FROM memory_store WHERE namespace=? AND key=?")
    .get(NS, agentId) as { value: string } | undefined;
  return row ? AdvertisementStateSchema.parse(JSON.parse(decryptIfNeeded(row.value))) : null;
}
export function putAdvertisement(state: AdvertisementState): void {
  const checked = AdvertisementStateSchema.parse(state);
  getDb().prepare("INSERT INTO memory_store(namespace,key,value,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .run(NS, state.agent_id, encrypt(JSON.stringify(checked)), state.updated_at, state.updated_at);
}
export function deleteAdvertisement(agentId: string): void {
  getDb().prepare("DELETE FROM memory_store WHERE namespace=? AND key=?").run(NS, agentId);
}
export function invalidateAdvertisement(agentId: string): void {
  const prior = getAdvertisement(agentId);
  if (prior) putAdvertisement({ ...prior, status: prior.enabled ? "stale" : "disabled", advertisement: null, updated_at: new Date().toISOString() });
}
export function notifyAdvertisementSourceChanged(agentId: string): void {
  try {
    invalidateAdvertisement(agentId);
    if (!getAdvertisementPolicy().enabled) return;
  } catch {
    console.warn("[advertisements] config saved but metadata invalidation failed");
    return;
  }
  void import("@/lib/agents/advertisement-service")
    .then(({ advertisementService }) => advertisementService().refresh(agentId))
    .catch(() => console.warn("[advertisements] post-save refresh failed"));
}
export function reserveAdvertisementCall(timestamp: number, limit: number): boolean {
  return withDbTransaction(() => {
    const key = "agent-advertisement-usage";
    const row = getDb().prepare("SELECT value FROM memory_store WHERE namespace=? AND key=?")
      .get("app-settings", key) as { value: string } | undefined;
    const prior: unknown = row ? JSON.parse(row.value) : [];
    if (!Array.isArray(prior) || !prior.every((item) => typeof item === "number" && Number.isFinite(item))) {
      throw new Error("Invalid stored advertisement usage ledger");
    }
    const calls = prior.filter((item: number) => item > timestamp - 3600000);
    if (calls.length >= limit) return false;
    calls.push(timestamp);
    const now = new Date(timestamp).toISOString();
    getDb().prepare("INSERT INTO memory_store(namespace,key,value,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .run("app-settings", key, JSON.stringify(calls), now, now);
    return true;
  });
}
