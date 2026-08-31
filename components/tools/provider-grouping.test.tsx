import { describe, expect, it } from "vitest";
import {
  groupByProvider,
  labelForProvider,
  OTHER_PROVIDER_KEY,
  providerForToolName,
  PROVIDER_LABELS,
} from "./provider-grouping";
import { KNOWN_BRAND_SLUGS } from "@/components/models/ProviderLogo";

describe("provider-grouping", () => {
  it("derives known provider slugs from tool names", () => {
    expect(providerForToolName("gmail_search")).toBe("gmail");
    expect(providerForToolName("outlook_send_email")).toBe("outlook");
    expect(providerForToolName("icloud_mail_list_messages")).toBe("icloud");
    expect(providerForToolName("github_create_issue")).toBe("github");
  });

  it("prefers longer prefixes (jira_align beats jira)", () => {
    expect(providerForToolName("jira_align_list_objectives")).toBe("jira_align");
  });

  it("aliases short brand prefixes to their canonical slug (ms -> microsoft)", () => {
    // Regression guard for the "ms_* tools land in the Other bucket" audit
    // finding: ms_graph_*, ms_search, ms_people_resolve and every ms_todo_*
    // tool must resolve to the microsoft brand so the Microsoft category
    // and Tasks category render a proper Microsoft provider box next to
    // iCloud / Gmail / Outlook.
    expect(providerForToolName("ms_graph_get")).toBe("microsoft");
    expect(providerForToolName("ms_search")).toBe("microsoft");
    expect(providerForToolName("ms_people_resolve")).toBe("microsoft");
    expect(providerForToolName("ms_todo_list_tasks")).toBe("microsoft");
    expect(providerForToolName("ms_todo_create_task")).toBe("microsoft");
  });

  it("aliases bare calendar_* to google (Google Calendar tools)", () => {
    // Regression guard for the "calendar_* tools land in Other" report:
    // Google Calendar tools are registered as bare calendar_* (no
    // google_ prefix) while Outlook / iCloud carry outlook_calendar_* /
    // icloud_calendar_*. Bare calendar_* must alias to google so the
    // Calendar category renders a Google provider box next to Outlook
    // and iCloud instead of dumping the six Google entries into Other.
    expect(providerForToolName("calendar_list_calendars")).toBe("google");
    expect(providerForToolName("calendar_list_events")).toBe("google");
    expect(providerForToolName("calendar_get_event")).toBe("google");
    expect(providerForToolName("calendar_create_event")).toBe("google");
    expect(providerForToolName("calendar_update_event")).toBe("google");
    expect(providerForToolName("calendar_delete_event")).toBe("google");
  });

  it("returns the OTHER bucket for unknown prefixes", () => {
    expect(providerForToolName("read_memory")).toBe(OTHER_PROVIDER_KEY);
    expect(providerForToolName("terminal")).toBe(OTHER_PROVIDER_KEY);
  });

  it("labels providers and falls back to title-case", () => {
    expect(labelForProvider("gmail")).toBe("Gmail");
    expect(labelForProvider("icloud")).toBe("iCloud");
    expect(labelForProvider(OTHER_PROVIDER_KEY)).toBe("Other");
    expect(labelForProvider("some_brand")).toBe("Some Brand");
  });

  it("groups by provider preserving first-seen order, Other last", () => {
    const names = [
      "gmail_search",
      "outlook_send_email",
      "read_memory",
      "gmail_get_message",
      "icloud_mail_list_folders",
      "terminal",
    ];
    const groups = groupByProvider(names, (n) => n);
    expect(groups.map((g) => g.provider)).toEqual([
      "gmail",
      "outlook",
      "icloud",
      OTHER_PROVIDER_KEY,
    ]);
    expect(groups[0]?.items).toEqual(["gmail_search", "gmail_get_message"]);
    expect(groups[3]?.items).toEqual(["read_memory", "terminal"]);
  });

  it("returns a single Other group when nothing matches", () => {
    const groups = groupByProvider(["a_tool", "another_tool"], (n) => n);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.provider).toBe(OTHER_PROVIDER_KEY);
  });

  it("every KNOWN_BRAND_SLUGS entry has a PROVIDER_LABELS label", () => {
    // Drift guard: KNOWN_BRAND_SLUGS (source of truth in ProviderLogo.tsx)
    // and PROVIDER_LABELS (display names) can silently diverge. If a new
    // brand icon is added but nobody remembers to add a label, the fallback
    // title-caser kicks in and can produce ugly labels (e.g. "Github-copilot"
    // instead of "GitHub"). Anything with an icon MUST have an explicit
    // label here.
    const missing = KNOWN_BRAND_SLUGS.filter((slug) => !(slug in PROVIDER_LABELS));
    expect(missing, `slugs missing a label: ${missing.join(", ")}`).toEqual([]);
  });
});
