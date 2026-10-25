import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const smtp = vi.hoisted(() => ({
  createTransport: vi.fn(), sendMail: vi.fn(), close: vi.fn(),
}));
vi.mock("nodemailer", () => ({
  default: { createTransport: smtp.createTransport },
}));
import {
  icloudMailSendEmailTool,
  icloudExecuteTools,
  icloudMailTools,
  resolveICloudAuthFromEnv,
  setAuthResolver,
} from "../src/index.js";

const input = { to: ["recipient@example.com"], subject: "Synthetic message", body: "Synthetic body" };
const auth = { appleId: "synthetic@icloud.com", appPassword: "abcd-efgh-ijkl-mnop" };

beforeEach(() => {
  vi.resetAllMocks();
  setAuthResolver(() => auth);
  smtp.createTransport.mockReturnValue({ sendMail: smtp.sendMail, close: smtp.close });
  smtp.sendMail.mockResolvedValue({
    accepted: input.to, rejected: [], messageId: "<synthetic@example.com>",
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  setAuthResolver(resolveICloudAuthFromEnv);
});

describe("iCloud SMTP send", () => {
  it("uses standard SMTP STARTTLS and the full address with a normalized app password", async () => {
    const response = JSON.parse(await icloudMailSendEmailTool.invoke(input));
    expect(smtp.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: "smtp.mail.me.com", port: 587, secure: false, requireTLS: true,
      auth: { user: auth.appleId, pass: "abcdefghijklmnop" },
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
    }));
    expect(smtp.sendMail).toHaveBeenCalledWith({
      from: auth.appleId, to: input.to, subject: input.subject, text: input.body,
      cc: undefined, bcc: undefined, disableFileAccess: true, disableUrlAccess: true,
    });
    expect(response).toEqual({
      ok: true, status: "accepted_by_smtp", message_id: "<synthetic@example.com>", accepted_count: 1,
    });
    expect(smtp.close).toHaveBeenCalledOnce();
  });

  it("supports a configured mail address without confusing SMTP and Apple account identities", async () => {
    setAuthResolver(() => ({ ...auth, appleId: "apple-account@example.com", mailAddress: "synthetic@icloud.com" }));
    await icloudMailSendEmailTool.invoke(input);
    expect(smtp.createTransport.mock.calls[0][0].auth.user).toBe("synthetic@icloud.com");
    expect(smtp.sendMail.mock.calls[0][0].from).toBe("synthetic@icloud.com");
  });

  it("reads the SMTP mail address through the existing environment resolver", async () => {
    vi.stubEnv("ICLOUD_APPLE_ID", "apple-account@example.com");
    vi.stubEnv("ICLOUD_APP_PASSWORD", "abcd-efgh-ijkl-mnop");
    vi.stubEnv("ICLOUD_MAIL_ADDRESS", "synthetic@icloud.com");
    setAuthResolver(resolveICloudAuthFromEnv);
    await icloudMailSendEmailTool.invoke(input);
    expect(smtp.createTransport.mock.calls[0][0].auth.user).toBe("synthetic@icloud.com");
  });

  it.each(["me.com", "mac.com"])("accepts legacy iCloud mail addresses on %s", async (domain) => {
    setAuthResolver(() => ({ ...auth, appleId: `synthetic@${domain}` }));
    await icloudMailSendEmailTool.invoke(input);
    expect(smtp.createTransport.mock.calls[0][0].auth.user).toBe(`synthetic@${domain}`);
  });

  it("refuses to infer a sender from a non-mail Apple ID", async () => {
    setAuthResolver(() => ({ ...auth, appleId: "apple-account@example.com" }));
    const response = JSON.parse(await icloudMailSendEmailTool.invoke(input));
    expect(response.error).toContain("ICLOUD_MAIL_ADDRESS");
    expect(smtp.createTransport).not.toHaveBeenCalled();
  });

  it("rejects an invalid configured sender before connecting", async () => {
    setAuthResolver(() => ({ ...auth, mailAddress: "synthetic@icloud.com\r\nBcc: hidden@example.com" }));
    const response = JSON.parse(await icloudMailSendEmailTool.invoke(input));
    expect(response.error).toContain("full iCloud Mail address");
    expect(smtp.createTransport).not.toHaveBeenCalled();
  });

  it("returns missing credentials without connecting", async () => {
    setAuthResolver(() => ({ error: "iCloud is not configured" }));
    expect(JSON.parse(await icloudMailSendEmailTool.invoke(input)).error).toContain("not configured");
    expect(smtp.createTransport).not.toHaveBeenCalled();
  });

  it("passes HTML, CC/BCC, and RFC threading metadata to the MIME library", async () => {
    await icloudMailSendEmailTool.invoke({
      ...input, body: "<p>Synthetic</p>", content_type: "html",
      cc: ["copy@example.com"], bcc: ["hidden@example.com"], in_reply_to: "<parent@example.com>",
    });
    expect(smtp.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      html: "<p>Synthetic</p>", cc: ["copy@example.com"], bcc: ["hidden@example.com"],
      inReplyTo: "<parent@example.com>", references: ["<parent@example.com>"],
    }));
    expect(smtp.sendMail.mock.calls[0][0]).not.toHaveProperty("text");
  });

  it("reports partial acceptance rather than a success-shaped response or retry", async () => {
    smtp.sendMail.mockResolvedValueOnce({
      accepted: ["recipient@example.com"], rejected: ["copy@example.com"], messageId: "<partial@example.com>",
    });
    const response = JSON.parse(await icloudMailSendEmailTool.invoke({ ...input, cc: ["copy@example.com"] }));
    expect(response.ok).toBeUndefined();
    expect(response.error).toContain("only some recipients");
    expect(response.accepted_count).toBe(1);
    expect(response.rejected).toEqual(["copy@example.com"]);
    expect(smtp.sendMail).toHaveBeenCalledOnce();
    expect(smtp.close).toHaveBeenCalledOnce();
  });

  it("does not report success if no recipients were accepted", async () => {
    smtp.sendMail.mockResolvedValueOnce({ accepted: [], rejected: input.to, messageId: "<rejected@example.com>" });
    const response = JSON.parse(await icloudMailSendEmailTool.invoke(input));
    expect(response.error).toContain("did not accept any");
    expect(response.ok).toBeUndefined();
  });

  it.each([
    ["EAUTH", "authentication failed"],
    ["EENVELOPE", "rejected the sender or recipients"],
    ["ETIMEDOUT", "delivery status may be unknown"],
    ["ESOCKET", "delivery status may be unknown"],
  ])("sanitizes %s errors and closes the connection without retrying", async (code, expected) => {
    smtp.sendMail.mockRejectedValueOnce(Object.assign(new Error("private server response synthetic-password"), { code }));
    const response = JSON.parse(await icloudMailSendEmailTool.invoke(input));
    expect(response.error).toContain(expected);
    expect(response.error).not.toContain("synthetic-password");
    expect(response.ok).toBeUndefined();
    expect(smtp.sendMail).toHaveBeenCalledOnce();
    expect(smtp.close).toHaveBeenCalledOnce();
  });

  it.each([
    { to: [] }, { to: ["invalid"] }, { cc: ["invalid"] }, { bcc: ["invalid"] },
    { to: ["recipient@example.com\r\nBcc: hidden@example.com"] },
    { subject: "Synthetic\r\nBcc: hidden@example.com" },
    { body: "x".repeat(100_001) },
    { in_reply_to: "123" }, { in_reply_to: "<parent>" },
    { in_reply_to: "<parent@example.com>\r\nInjected: x" },
    { from: "spoof@example.com" }, { attachments: [{ path: "C:\\synthetic-secret" }] },
    { to: Array(101).fill("recipient@example.com") },
  ])("rejects invalid or unsupported inputs before transport creation", async (patch) => {
    await expect(icloudMailSendEmailTool.invoke({ ...input, ...patch })).rejects.toThrow();
    expect(smtp.createTransport).not.toHaveBeenCalled();
  });

  it("registers sending only in execute and the complete mail bundle", () => {
    expect(icloudExecuteTools).toContain(icloudMailSendEmailTool);
    expect(icloudMailTools).toContain(icloudMailSendEmailTool);
  });
});
