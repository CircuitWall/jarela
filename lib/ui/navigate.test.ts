import { describe, expect, it } from "vitest";
import { parseHref } from "./navigate";

describe("parseHref legacy Knowledge routes", () => {
  it.each([
    "/?tab=documents",
    "/?tab=memory",
    "/?tab=tools&item=documents",
    "/?tab=tools&item=memory",
  ])("routes %s to Knowledge", (href) => {
    expect(parseHref(href)).toMatchObject({ tab: "memory", item: undefined, external: false });
  });
});