import { afterEach, describe, expect, it, vi } from "vitest";

const { outlookCreateDraftTool, outlookSearchTool, outlookSendEmailTool } = await import("./outlook");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("outlook source links", () => {
  it("returns the Graph webLink and a cite_as markdown link per message", async () => {
    vi.stubEnv("OUTLOOK_CLIENT_ID", "test-client");
    vi.stubEnv("OUTLOOK_CLIENT_SECRET", "test-secret");
    vi.stubEnv("OUTLOOK_REFRESH_TOKEN", "outlook-source-link-refresh");
    const webLink = "https://outlook.office365.com/owa/?ItemID=AAMk%2BA%3D&exvsurl=1&viewmodel=ReadMessageItem";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/oauth2/")) return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({
        value: [
          { id: "m1", subject: "Budget [Q3]", webLink },
          { id: "m2", subject: "No link" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const out = JSON.parse(await outlookSearchTool.invoke({ query: "budget" })) as {
      messages: Array<{ web_link: string | null; cite_as: string | null }>;
    };

    expect(out.messages[0].web_link).toBe(webLink);
    expect(out.messages[0].cite_as).toBe(`[Budget \\[Q3\\]](${webLink})`);
    expect(out.messages[1]).toMatchObject({ web_link: null, cite_as: null });
  });
});

describe("outlook_create_draft", () => {
  it("rejects oversized draft bodies before calling Microsoft Graph", async () => {
    await expect(outlookCreateDraftTool.invoke({
      to: ["user@example.test"],
      subject: "Oversized",
      body: "x".repeat(100_001),
    })).rejects.toThrow(/100000/);
  });

  it("rejects oversized send bodies before calling Microsoft Graph", async () => {
    await expect(outlookSendEmailTool.invoke({
      to: ["user@example.test"],
      subject: "Oversized",
      body: "x".repeat(100_001),
    })).rejects.toThrow(/100000/);
  });
});