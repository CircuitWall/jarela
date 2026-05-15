import { getDb } from "@/lib/db";

const now = () => new Date().toISOString();

export interface UserProfileRow {
  id: string;
  name: string;
  icon: string | null;
  about: string;
  created_at: string;
  updated_at: string;
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
  db.prepare(
    `INSERT OR REPLACE INTO user_profile (id, name, icon, about, created_at, updated_at)
     VALUES ('me', ?, ?, ?, ?, ?)`,
  ).run(name, icon ?? null, about, created_at, t);
  return getUserProfile()!;
}
