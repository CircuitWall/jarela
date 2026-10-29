export function validatePersonalBriefing(input) {
  const issues = [];
  const issue = (path, message) => issues.push({ path, message });
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
  const identifiers = (value, min, max) => Array.isArray(value) && value.length >= min && value.length <= max && Array.from(value).every((id) => text(id, 200));
  if (!object(input)) {
    issue("", "Expected an object.");
  } else {
    if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 100) {
      issue("sources", "Expected 1-100 sources.");
    } else {
      Array.from(input.sources).forEach((source, index) => {
        if (!object(source) || !text(source.id, 200) || typeof source.available !== "boolean") {
          issue(`sources.${index}`, "Expected a source ID and boolean availability.");
        }
      });
    }
    if (!object(input.briefing)) {
      issue("briefing", "Expected a briefing object.");
    } else {
      if (!Array.isArray(input.briefing.items) || input.briefing.items.length > 40) {
        issue("briefing.items", "Expected at most 40 items.");
      } else {
        Array.from(input.briefing.items).forEach((item, index) => {
          if (!object(item) || !text(item.text, 2000) || !identifiers(item.source_ids, 1, 20)) {
            issue(`briefing.items.${index}`, "Expected text and 1-20 source IDs within length limits.");
          }
        });
      }
      if (!identifiers(input.briefing.unavailable_source_ids, 0, 100)) {
        issue("briefing.unavailable_source_ids", "Expected at most 100 source IDs.");
      }
    }
  }
  if (issues.length === 0) {
    const sources = input.sources.map(({ id, available }) => ({ id: id.trim(), available }));
    const briefing = {
      items: input.briefing.items.map(({ text, source_ids }) => ({
        text: text.trim(), source_ids: source_ids.map((id) => id.trim()),
      })),
      unavailable_source_ids: input.briefing.unavailable_source_ids.map((id) => id.trim()),
    };
    const byId = new Map(sources.map((source) => [source.id, source]));
    if (byId.size !== sources.length) issue("sources", "Source IDs must be unique.");
    const gaps = new Set(briefing.unavailable_source_ids);
    if (gaps.size !== briefing.unavailable_source_ids.length) {
      issue("briefing.unavailable_source_ids", "Source gaps must be unique.");
    }
    for (const [index, id] of briefing.unavailable_source_ids.entries()) {
      if (byId.get(id)?.available !== false) {
        issue(`briefing.unavailable_source_ids.${index}`, "A source gap must identify an unavailable input source.");
      }
    }
    for (const source of sources) {
      if (!source.available && !gaps.has(source.id)) {
        issue("briefing.unavailable_source_ids", "Every unavailable input source must be disclosed.");
      }
    }
    for (const [index, item] of briefing.items.entries()) {
      if (new Set(item.source_ids).size !== item.source_ids.length) {
        issue(`briefing.items.${index}.source_ids`, "Item source references must be unique.");
      }
      for (const id of item.source_ids) {
        if (byId.get(id)?.available !== true) {
          issue(`briefing.items.${index}.source_ids`, "Items may reference only available input sources.");
        }
      }
    }
    if (issues.length === 0) {
      return {
        ok: true,
        briefing,
        checks: ["structure", "reference_membership", "source_gap_disclosure"],
        limitation: "Checks use caller-supplied sources; they do not verify retrieval provenance, factual accuracy, completeness, or permission to act.",
      };
    }
  }
  return { ok: false, error: "Personal briefing failed structural and source-reference validation.", issues };
}
