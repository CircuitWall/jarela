import { describe, expect, it, afterEach, vi } from "vitest";
import { linkedinEnterpriseCreatePostTool, linkedinEnterpriseListOrganizationsTool, setAuthResolver } from "../src/index";

afterEach(() => { vi.restoreAllMocks(); });

describe("LinkedIn enterprise tools", () => {
  it("lists approved administrator organizations", async () => {
    setAuthResolver(() => ({ accessToken: "enterprise-test-token", version: "202608" }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ elements: [] }), { status: 200 }));
    await linkedinEnterpriseListOrganizationsTool.invoke({});
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("organizationAcls?q=roleAssignee");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("role=ADMINISTRATOR");
  });

  it("publishes with an organization URN", async () => {
    setAuthResolver(() => ({ accessToken: "enterprise-test-token", version: "202608" }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "post-1" }), { status: 201 }));
    await linkedinEnterpriseCreatePostTool.invoke({ organization_id: "12345", text: "Test page post" });
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({ author: "urn:li:organization:12345", commentary: "Test page post" });
  });
});
