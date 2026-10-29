const kinds = new Set(["preference", "fact", "decision", "constraint", "project_context", "contact", "task"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
const timestamp = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
};

export function planMemoryCleanup(input) {
  const issues = [];
  if (!object(input) || !timestamp(input.now)) {
    issues.push({ path: "now", message: "Expected an explicit valid UTC timestamp." });
  }
  if (!object(input) || !Array.isArray(input.entries) || input.entries.length > 100) {
    issues.push({ path: "entries", message: "Expected at most 100 structured fact projections." });
  } else {
    const keys = new Set();
    Array.from(input.entries).forEach((entry, index) => {
      if (!object(entry) || !text(entry.key, 200) || !kinds.has(entry.kind)
        || !text(entry.subject, 160) || !text(entry.content, 8000)
        || !["active", "archived"].includes(entry.status)
        || !(entry.expires_at === null || timestamp(entry.expires_at))) {
        issues.push({ path: `entries.${index}`, message: "Invalid key, kind, subject, content, status or UTC expiry." });
      } else if (keys.has(entry.key.trim())) {
        issues.push({ path: `entries.${index}.key`, message: "Keys must be unique within facts." });
      } else {
        keys.add(entry.key.trim());
      }
    });
  }
  if (issues.length > 0) return { ok: false, error: "Memory cleanup input is invalid.", issues };

  const expired_keys = [];
  const groups = new Map();
  for (const entry of input.entries) {
    if (entry.status !== "active") continue;
    if (entry.expires_at !== null && Date.parse(entry.expires_at) <= Date.parse(input.now)) {
      expired_keys.push(entry.key.trim());
      continue;
    }
    const signature = JSON.stringify([entry.kind, entry.subject.trim(), entry.content.trim(), entry.expires_at]);
    const keys = groups.get(signature) ?? [];
    keys.push(entry.key.trim());
    groups.set(signature, keys);
  }
  const duplicate_groups = [...groups.values()].filter((keys) => keys.length > 1)
    .map((keys) => keys.sort()).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return {
    ok: true,
    expired_keys: expired_keys.sort(),
    duplicate_groups,
    checks: ["explicit_time", "expiry", "exact_kind_subject_content_expiry"],
    limitation: "Candidates from supplied facts only; not a complete memory scan. Matching text does not prove equivalent provenance, confidence, tags or history. Review full records before authorized archival; no writes, semantic merging or deletion performed.",
  };
}
