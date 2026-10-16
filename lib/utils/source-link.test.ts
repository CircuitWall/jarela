import { describe, expect, it } from "vitest";
import { citeAs, httpsUrlOrNull } from "./source-link";

describe("httpsUrlOrNull", () => {
  it("accepts absolute https URLs", () => {
    expect(httpsUrlOrNull("https://outlook.office365.com/owa/?ItemID=AAk%3D&exvsurl=1")).toBe(
      "https://outlook.office365.com/owa/?ItemID=AAk%3D&exvsurl=1",
    );
  });

  it("rejects missing, relative, and non-https URLs", () => {
    for (const url of [null, undefined, "", "/mail/123", "http://example.com", "javascript:alert(1)", "message://%3cid%3e", "not a url"]) {
      expect(httpsUrlOrNull(url)).toBeNull();
    }
  });
});

describe("citeAs", () => {
  it("builds a markdown link from a label and URL", () => {
    expect(citeAs("Quarterly report", "https://www.google.com/calendar/event?eid=abc")).toBe(
      "[Quarterly report](https://www.google.com/calendar/event?eid=abc)",
    );
  });

  it("returns null without a usable URL", () => {
    expect(citeAs("Subject", null)).toBeNull();
    expect(citeAs("Subject", "http://insecure.example")).toBeNull();
  });

  it("escapes brackets and flattens whitespace in the label", () => {
    expect(citeAs("Re: [EXT]\n  budget\\plan", "https://x.test/a")).toBe("[Re: \\[EXT\\] budget\\\\plan](https://x.test/a)");
  });

  it("falls back to a default label for an empty subject", () => {
    expect(citeAs("   ", "https://x.test/a", "Outlook message")).toBe("[Outlook message](https://x.test/a)");
    expect(citeAs(null, "https://x.test/a")).toBe("[source](https://x.test/a)");
  });

  it("caps long labels", () => {
    const link = citeAs("x".repeat(200), "https://x.test/a")!;
    const label = link.slice(1, link.indexOf("]("));
    expect(label.length).toBe(80);
    expect(label.endsWith("…")).toBe(true);
  });

  it("encodes characters that would end the markdown destination", () => {
    const link = citeAs("Event", "https://x.test/path(1)?q=a b")!;
    expect(link).toBe("[Event](https://x.test/path%281%29?q=a%20b)");
    expect(/^\[[^\]]*\]\([^()\s]+\)$/.test(link)).toBe(true);
  });
});
