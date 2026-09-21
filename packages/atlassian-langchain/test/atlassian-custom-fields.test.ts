import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setAuthResolver,
  coerceCustomFieldValue,
  jiraUpdateIssueTool,
  jiraCreateIssueTool,
  type JiraFieldDef,
} from "../src/index";
import { setupFetchHarness } from "./harness";

// Jira Cloud rejects a bare string for "option" (single-select) custom
// fields — e.g. the risk-assessment fields (customfield_11446-11451) —
// with "Specify a valid 'id' or 'name' for <field>". It needs
// {value: "<label>"}. See issue #568 P0 item 2.

// loadJiraFields caches by auth.url for an hour, so each test that hits
// the field-list endpoint needs its own url — otherwise a later test's
// queued field-list response never gets consumed and every `t.calls`
// index after it is off by one.
let siteCounter = 0;
function useFreshSite(): void {
  siteCounter += 1;
  setAuthResolver(() => ({
    url: `https://test-${siteCounter}.atlassian.net`,
    email: "tester@example.com",
    apiToken: "test-token",
  }));
}

const t = setupFetchHarness();
beforeEach(() => { t.reset(); useFreshSite(); });
afterEach(() => t.cleanup());

describe("coerceCustomFieldValue", () => {
  it("wraps a bare string as {value} for an option-type field", () => {
    const field: JiraFieldDef = { id: "customfield_11447", name: "Blast radius", custom: true, schema: { type: "option" } };
    expect(coerceCustomFieldValue(field, "High")).toEqual({ value: "High" });
  });

  it("leaves an already-shaped object untouched for an option-type field", () => {
    const field: JiraFieldDef = { id: "customfield_11447", name: "Blast radius", custom: true, schema: { type: "option" } };
    expect(coerceCustomFieldValue(field, { id: "10042" })).toEqual({ id: "10042" });
  });

  it("wraps each string in an array for a multi-select (array of option) field", () => {
    const field: JiraFieldDef = {
      id: "customfield_20000", name: "Affected regions", custom: true,
      schema: { type: "array", items: "option" },
    };
    expect(coerceCustomFieldValue(field, ["EU", "US"])).toEqual([{ value: "EU" }, { value: "US" }]);
  });

  it("leaves non-option field types untouched (text, number, date, no schema at all)", () => {
    const textField: JiraFieldDef = { id: "customfield_10015", name: "Due Date", custom: true, schema: { type: "date" } };
    expect(coerceCustomFieldValue(textField, "2026-06-15")).toBe("2026-06-15");

    const noSchemaField: JiraFieldDef = { id: "customfield_10600", name: "Story Points", custom: true };
    expect(coerceCustomFieldValue(noSchemaField, 8)).toBe(8);

    expect(coerceCustomFieldValue(undefined, "anything")).toBe("anything");
  });
});

const FIELD_LIST_RESPONSE = [
  { id: "summary", name: "Summary", custom: false, schema: { type: "string", custom: undefined } },
  {
    id: "customfield_11447", name: "What is the potential blast radius of the change?", custom: true,
    schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
  },
  {
    id: "customfield_10015", name: "Due Date", custom: true,
    schema: { type: "date" },
  },
];

describe("jira_update_issue custom_fields", () => {
  it("auto-wraps a bare string as {value} for an option-type custom field", async () => {
    t.setResponses([
      { body: FIELD_LIST_RESPONSE },
      { body: { key: "PROJ-1" } },
    ]);

    const out = JSON.parse(await jiraUpdateIssueTool.invoke({
      issue_key: "PROJ-1",
      custom_fields: { customfield_11447: "High" },
    }) as string);

    expect(out.ok).toBe(true);
    const updateCall = t.calls[1];
    const body = JSON.parse(updateCall.init.body as string);
    expect(body.fields.customfield_11447).toEqual({ value: "High" });
  });

  it("passes a non-option custom field value through unchanged", async () => {
    t.setResponses([
      { body: FIELD_LIST_RESPONSE },
      { body: { key: "PROJ-1" } },
    ]);

    await jiraUpdateIssueTool.invoke({
      issue_key: "PROJ-1",
      custom_fields: { "Due Date": "2026-06-15" },
    });

    const updateCall = t.calls[1];
    const body = JSON.parse(updateCall.init.body as string);
    expect(body.fields.customfield_10015).toBe("2026-06-15");
  });

  it("still returns the client-side guard error when no fields are passed", async () => {
    const out = JSON.parse(await jiraUpdateIssueTool.invoke({ issue_key: "PROJ-1" }) as string);
    expect(out.error).toMatch(/no fields to update — pass at least one of/);
    expect(t.calls).toHaveLength(0);
  });
});

describe("jira_create_issue custom_fields", () => {
  it("auto-wraps a bare string as {value} for an option-type custom field", async () => {
    t.setResponses([
      { body: FIELD_LIST_RESPONSE },
      { body: { key: "PROJ-2" } },
    ]);

    const out = JSON.parse(await jiraCreateIssueTool.invoke({
      project_key: "PROJ",
      summary: "New issue",
      custom_fields: { customfield_11447: "Low" },
    }) as string);

    expect(out.ok).toBe(true);
    const createCall = t.calls[1];
    const body = JSON.parse(createCall.init.body as string);
    expect(body.fields.customfield_11447).toEqual({ value: "Low" });
  });
});
