import { describe, expect, it, afterEach, vi } from "vitest";
import { linkedinPersonalCreatePostTool, linkedinPersonalGetProfileTool, setAuthResolver } from "../src/index";

afterEach(() => { vi.restoreAllMocks(); });

describe("LinkedIn personal tools", () => {
  it("gets the OIDC profile", async () => {
    setAuthResolver(() => ({ accessToken: "personal-test-token", version: "202608" }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ sub: "member-1", name: "Test Member" }), { status: 200 }));
    expect(await linkedinPersonalGetProfileTool.invoke({})).toContain("member-1");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.linkedin.com/v2/userinfo");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ Authorization: "Bearer personal-test-token" }) });
  });

  it("uses the member URN and versioned REST headers when publishing", async () => {
    setAuthResolver(() => ({ accessToken: "personal-test-token", version: "202608" }));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: "member-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "post-1" }), { status: 201 }));
    await linkedinPersonalCreatePostTool.invoke({ text: "Test post", visibility: "PUBLIC" });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.linkedin.com/rest/posts");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: expect.objectContaining({ "Linkedin-Version": "202608", "X-Restli-Protocol-Version": "2.0.0" }) });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1] && (fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toMatchObject({ author: "urn:li:person:member-1", commentary: "Test post" });
  });
});
