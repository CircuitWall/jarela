import { describe, expect, it } from "vitest";
import { collectFormSubmission, sanitizeSubmittedFields } from "./form-submission.mjs";

describe("sanitizeSubmittedFields", () => {
  it("keeps only preference-like values and excludes sensitive labels and values", () => {
    expect(sanitizeSubmittedFields([
      { label: "Preferred language", value: "Dutch" },
      { label: "Password preference", value: "never store this" },
      { label: "Notification email", value: "person@example.com" },
      { label: "Favorite color", value: "Blue" },
      { label: "Order comment", value: "Keep this private" },
    ])).toEqual([
      { label: "Preferred language", value: "Dutch" },
      { label: "Favorite color", value: "Blue" },
    ]);
  });

  it("caps field count and lengths", () => {
    const fields = Array.from({ length: 25 }, (_, index) => ({
      label: `Preference ${index} ${"l".repeat(220)}`,
      value: "x".repeat(600),
    }));
    const safe = sanitizeSubmittedFields(fields);
    expect(safe).toHaveLength(20);
    expect(safe[0].label).toHaveLength(200);
    expect(safe[0].value).toHaveLength(500);
  });
});

describe("collectFormSubmission", () => {
  it("collects only safe preference fields and removes URL query and fragment", () => {
    const controls = [
      {
        tagName: "SELECT",
        type: "select-one",
        name: "preferred_language",
        value: "nl",
        disabled: false,
        multiple: false,
        selectedOptions: [{ label: "Dutch", value: "nl" }],
        labels: [{ innerText: "Preferred language" }],
        getAttribute: () => null,
      },
      {
        tagName: "INPUT",
        type: "password",
        name: "password",
        value: "secret",
        disabled: false,
        labels: [{ innerText: "Password preference" }],
        getAttribute: () => null,
      },
    ];
    const form = { elements: controls };
    const result = collectFormSubmission(form, {
      href: "https://example.test/settings?session=private#section",
      title: "Settings",
      submittedAt: "2026-11-05T22:00:00.000Z",
    });

    expect(result).toEqual({
      site: "example.test",
      url: "https://example.test/settings",
      title: "Settings",
      submitted_at: "2026-11-05T22:00:00.000Z",
      fields: [{ label: "Preferred language preferred_language", value: "Dutch" }],
    });
  });

  it("does not capture forms without preferences or from sensitive sites", () => {
    const form = {
      elements: [{
        tagName: "INPUT",
        type: "text",
        name: "comment",
        value: "hello",
        disabled: false,
        labels: [{ innerText: "Comment" }],
        getAttribute: () => null,
      }],
    };
    expect(collectFormSubmission(form, { href: "https://example.test/form" })).toBeNull();
    expect(collectFormSubmission(form, { href: "https://portal.health.example/form" })).toBeNull();
    expect(collectFormSubmission(form, { href: "http://localhost:4312/settings" })).toBeNull();
  });
});
