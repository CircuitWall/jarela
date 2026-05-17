import { getDb } from "@/lib/db";

const now = () => new Date().toISOString();

export interface UserProfileRow {
  id: string;
  name: string;
  icon: string | null;
  about: string;
  created_at: string;
  updated_at: string;
  // ── Geolocation (opt-in) ─────────────────────────────────────────────
  // Populated by the client (navigator.geolocation) only when
  // location_consent === 1. All five fields are null when sharing is off.
  location_lat: number | null;
  location_lng: number | null;
  location_accuracy_m: number | null;
  location_label: string | null;
  location_updated_at: string | null;
  location_consent: number; // 0 | 1
}

export function getUserProfile(): UserProfileRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM user_profile WHERE id='me'")
      .get() as unknown as UserProfileRow) ?? null
  );
}

export function upsertUserProfile(
  name: string,
  icon: string | null,
  about: string,
): UserProfileRow {
  const t = now();
  const db = getDb();
  const existing = getUserProfile();
  const created_at = existing?.created_at ?? t;
  // Preserve location columns on profile edit — we only update them via the
  // dedicated location endpoints.
  db.prepare(
    `INSERT INTO user_profile (id, name, icon, about, created_at, updated_at)
     VALUES ('me', ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, icon=excluded.icon, about=excluded.about,
       updated_at=excluded.updated_at`,
  ).run(name, icon ?? null, about, created_at, t);
  return getUserProfile()!;
}

export function setLocationConsent(consent: boolean): UserProfileRow {
  const t = now();
  const db = getDb();
  // Ensure a row exists.
  const existing = getUserProfile();
  if (!existing) upsertUserProfile("", null, "");
  db.prepare(
    `UPDATE user_profile SET location_consent=?, updated_at=?
     ${consent ? "" : ", location_lat=NULL, location_lng=NULL, location_accuracy_m=NULL, location_label=NULL, location_updated_at=NULL"}
     WHERE id='me'`,
  ).run(consent ? 1 : 0, t);
  return getUserProfile()!;
}

export function updateUserLocation(input: {
  lat: number;
  lng: number;
  accuracy_m?: number | null;
  label?: string | null;
}): UserProfileRow {
  const existing = getUserProfile();
  if (!existing || existing.location_consent !== 1) {
    throw new Error("location sharing is not enabled");
  }
  const t = now();
  getDb()
    .prepare(
      `UPDATE user_profile SET
         location_lat=?, location_lng=?, location_accuracy_m=?, location_label=?,
         location_updated_at=?, updated_at=?
       WHERE id='me'`,
    )
    .run(
      input.lat,
      input.lng,
      input.accuracy_m ?? null,
      input.label ?? null,
      t,
      t,
    );
  return getUserProfile()!;
}
