import { describe, expect, it } from "vitest";
import {
  groupByProvider,
  labelForProvider,
  OTHER_PROVIDER_KEY,
  providerForToolName,
} from "./provider-grouping";

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

  it("returns the OTHER bucket for unknown prefixes", () => {
    expect(providerForToolName("read_memory")).toBe(OTHER_PROVIDER_KEY);
    expect(providerForToolName("shell_exec")).toBe(OTHER_PROVIDER_KEY);
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
      "shell_exec",
    ];
    const groups = groupByProvider(names, (n) => n);
    expect(groups.map((g) => g.provider)).toEqual([
      "gmail",
      "outlook",
      "icloud",
      OTHER_PROVIDER_KEY,
    ]);
    expect(groups[0]?.items).toEqual(["gmail_search", "gmail_get_message"]);
    expect(groups[3]?.items).toEqual(["read_memory", "shell_exec"]);
  });

  it("returns a single Other group when nothing matches", () => {
    const groups = groupByProvider(["a_tool", "another_tool"], (n) => n);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.provider).toBe(OTHER_PROVIDER_KEY);
  });
});
