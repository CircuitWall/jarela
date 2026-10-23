import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto/envelope", () => ({ encrypt: vi.fn(), decryptIfNeeded: vi.fn() }));
vi.mock("@/lib/files", () => ({ FILES_DIR: "", isSafeFileName: vi.fn() }));
const { ensureAgentUsageProfileColumn } = await import("./migrations");

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe("usage profile migration", () => {
  it.each(["home", "work", "dev", "custom", null, "unknown"])("migrates legacy %s once without overwriting agent choices", (preset) => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    db.exec(`CREATE TABLE user_profile (preset TEXT);
      CREATE TABLE agent_configs (
        id TEXT PRIMARY KEY, adaptive_mbti TEXT, citation_strictness TEXT,
        adaptive_persona_enabled INTEGER, adaptive_persona_strength INTEGER,
        adaptive_empathy INTEGER, adaptive_expressiveness INTEGER, adaptive_verbosity INTEGER
      )`);
    db.prepare("INSERT INTO user_profile VALUES (?)").run(preset);
    db.exec("INSERT INTO agent_configs VALUES ('one', 'ISFJ', 'standard', 1, 17, 29, 83, 97), ('two', 'INTJ', 'strict', 0, 0, 50, 50, 50)");
    ensureAgentUsageProfileColumn(db);
    const expected = preset && preset !== "unknown" ? preset : "custom";
    expect(db.prepare("SELECT usage_profile FROM agent_configs WHERE id='one'").get()?.usage_profile).toBe(expected);
    expect(db.prepare("SELECT adaptive_mbti, citation_strictness FROM agent_configs WHERE id='one'").get())
      .toMatchObject({ adaptive_mbti: "ISFJ", citation_strictness: "standard" });
    const tuned = {
      adaptive_persona_enabled: 1, adaptive_persona_strength: 17,
      adaptive_empathy: 29, adaptive_expressiveness: 83, adaptive_verbosity: 97,
    };
    expect(db.prepare("SELECT * FROM agent_configs WHERE id='one'").get()).toMatchObject(tuned);
    db.exec("UPDATE agent_configs SET usage_profile='dev' WHERE id='one'; UPDATE user_profile SET preset='home'");
    ensureAgentUsageProfileColumn(db);
    expect(db.prepare("SELECT usage_profile FROM agent_configs WHERE id='one'").get()?.usage_profile).toBe("dev");
    expect(db.prepare("SELECT * FROM agent_configs WHERE id='one'").get()).toMatchObject(tuned);
    expect(() => db.exec("UPDATE agent_configs SET usage_profile='invalid'")).toThrow();
  });
});
