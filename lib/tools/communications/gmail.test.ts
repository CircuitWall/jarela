import { afterEach, describe, expect, it, vi } from "vitest";
import { googleFetch } from "@/lib/integrations/gmail-oauth";

const { buildRawMessage, gmailCreateDraftTool, gmailModifyMessageTool, gmailSendEmailTool } = await import("./gmail");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gmail tools", () => {
  it("returns a structured error for a successful non-JSON Google API response", async () => {
    const baseUrl = "https://gmail.googleapis.com/gmail/v1/users/me";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("[binary data]", {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await googleFetch(
      { client_id: "test-client", client_secret: "test-secret", refresh_token: "unique-test-refresh-token" },
      "Gmail",
      baseUrl,
      "/messages",
    );

    expect(result).toMatchObject({
      error: expect.stringMatching(/expected a JSON object response \(content-type=application\/octet-stream.*first-bytes=/),
      url: `${baseUrl}/messages`,
    });
    expect(JSON.stringify(result)).not.toContain("[binary data]");
  });

  it("rejects oversized draft bodies before calling Gmail", async () => {
    await expect(gmailCreateDraftTool.invoke({
      to: ["user@example.test"],
      subject: "Oversized",
      body: "x".repeat(100_001),
    })).rejects.toThrow(/100000/);
  });

  it("rejects oversized send bodies before calling Gmail", async () => {
    await expect(gmailSendEmailTool.invoke({
      to: ["user@example.test"],
      subject: "Oversized",
      body: "x".repeat(100_001),
    })).rejects.toThrow(/100000/);
  });

  it("builds HTML MIME bodies when requested", () => {
    const raw = buildRawMessage({
      to: ["user@example.test"],
      subject: "HTML",
      body: "<p>Hello <strong>there</strong></p>",
      content_type: "html",
    });
    const decoded = Buffer.from(raw, "base64url").toString("utf8");

    expect(decoded).toContain("Content-Type: text/html; charset=\"UTF-8\"");
    expect(decoded).toContain("<p>Hello <strong>there</strong></p>");
  });

  it("returns an actionable auth recovery hint", async () => {
    const out = JSON.parse(await gmailModifyMessageTool.invoke({
      id: "msg-1",
      remove_labels: ["INBOX"],
    })) as { error?: string; error_code?: string; recovery_hint?: string };

    expect(out.error).toBeTruthy();
    expect(out.error_code).toBe("gmail_auth_required");
    expect(out.recovery_hint).toContain("Integrations");
  });
});