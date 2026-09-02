// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PoweredBy } from "./PoweredBy";

describe("PoweredBy", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.NEXT_PUBLIC_APP_NAME;
    delete process.env.NEXT_PUBLIC_APP_NAME;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_NAME;
    else process.env.NEXT_PUBLIC_APP_NAME = saved;
  });

  it("renders nothing in the unbranded upstream build", () => {
    const { container } = render(<PoweredBy />);
    expect(container.innerHTML).toBe("");
  });

  it("credits upstream once the app has been rebranded", () => {
    process.env.NEXT_PUBLIC_APP_NAME = "Acme Assistant";
    render(<PoweredBy />);
    const link = screen.getByRole("link", { name: "Powered by Jarela" });
    expect(link.getAttribute("href")).toBe("https://github.com/CircuitWall/jarela");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  // The credit must not follow the fork's own issue-tracker override.
  it("ignores the fork's issue-url override", () => {
    process.env.NEXT_PUBLIC_APP_NAME = "Acme Assistant";
    process.env.NEXT_PUBLIC_APP_ISSUE_URL = "https://example.com/bugs";
    render(<PoweredBy />);
    const link = screen.getByRole("link", { name: "Powered by Jarela" });
    expect(link.getAttribute("href")).toBe("https://github.com/CircuitWall/jarela");
    delete process.env.NEXT_PUBLIC_APP_ISSUE_URL;
  });
});
