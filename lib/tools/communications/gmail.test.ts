import { describe, expect, it } from "vitest";

const { buildRawMessage, gmailCreateDraftTool, gmailModifyMessageTool, gmailSendEmailTool } = await import("./gmail");

describe("gmail tools", () => {
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