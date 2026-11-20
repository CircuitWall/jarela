import { describe, it, expect, afterEach } from "vitest";
import { getAppOrigins, isAppOrigin } from "./app-origin";

const originalPort = process.env.PORT;
const originalPublic = process.env.JARELA_PUBLIC_URL;

afterEach(() => {
  if (originalPort === undefined) delete process.env.PORT;
  else process.env.PORT = originalPort;
  if (originalPublic === undefined) delete process.env.JARELA_PUBLIC_URL;
  else process.env.JARELA_PUBLIC_URL = originalPublic;
});

describe("isAppOrigin", () => {
  it("matches the loopback origins the app listens on", () => {
    delete process.env.PORT;
    delete process.env.JARELA_PUBLIC_URL;

    expect(getAppOrigins()).toEqual(["http://localhost:4312", "http://127.0.0.1:4312"]);
    expect(isAppOrigin("http://localhost:4312/?tab=tools")).toBe(true);
    expect(isAppOrigin("http://127.0.0.1:4312")).toBe(true);
  });

  it("follows the configured port", () => {
    process.env.PORT = "3000";
    expect(isAppOrigin("http://localhost:3000")).toBe(true);
    expect(isAppOrigin("http://localhost:4312")).toBe(false);
  });

  it("includes an explicitly configured public URL", () => {
    process.env.JARELA_PUBLIC_URL = "https://jarela.example:8443/";
    expect(isAppOrigin("https://jarela.example:8443/?tab=chat")).toBe(true);
  });

  it("is false for other sites and unusable input", () => {
    delete process.env.JARELA_PUBLIC_URL;
    expect(isAppOrigin("https://www.google.com/search?q=x")).toBe(false);
    expect(isAppOrigin("https://localhost.example.com")).toBe(false);
    expect(isAppOrigin("not a url")).toBe(false);
    expect(isAppOrigin(undefined)).toBe(false);
  });
});
