import { describe, expect, it } from "vitest";
import nodemailer from "nodemailer";

describe("standard mail library MIME behavior", () => {
  it("builds Unicode/threaded messages and a BCC envelope without using the network", async () => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const response = await transport.sendMail({
      from: "synthetic@icloud.com", to: ["recipient@example.com"],
      bcc: ["hidden@example.com"], subject: "Synthetic \u00e9",
      text: "Synthetic body", inReplyTo: "<parent@example.com>", references: ["<parent@example.com>"],
    });
    const message = response.message.toString();
    expect(message).toContain("In-Reply-To: <parent@example.com>");
    expect(message).toContain("References: <parent@example.com>");
    expect(message).toContain("=?UTF-8?");
    expect(response.envelope.to).toContain("hidden@example.com");
    transport.close();
  });

  it("encodes HTML as a text/html MIME body", async () => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    try {
      const response = await transport.sendMail({
        from: "synthetic@icloud.com", to: ["recipient@example.com"],
        subject: "Synthetic HTML", html: "<p>Synthetic <strong>HTML</strong></p>",
      });
      const message = response.message.toString();
      expect(message).toContain("Content-Type: text/html; charset=utf-8");
      expect(message).toContain("<p>Synthetic <strong>HTML</strong></p>");
    } finally {
      transport.close();
    }
  });
});
