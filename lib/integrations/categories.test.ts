import { describe, expect, it } from "vitest";
import { filterIntegrationsForProfile } from "./categories";
import type { IntegrationDefinition, IntegrationStatus } from "@/api/types";

const definitions = [
  { name: "model", category: "llm" },
  { name: "mail", category: "mail" },
  { name: "chat", category: "chat" },
  { name: "issues", category: "issue-tracker" },
  { name: "infra", category: "infrastructure" },
] as IntegrationDefinition[];
const names = (profile: "home" | "work" | "dev" | "custom", statuses: Record<string, IntegrationStatus> = {}) =>
  filterIntegrationsForProfile(definitions, statuses, profile).map((definition) => definition.name);

describe("agent profile credential discovery", () => {
  it("filters unconfigured integrations by usage and never filters Everything or Developer", () => {
    expect(names("home")).toEqual(["model", "mail", "chat"]);
    expect(names("work")).toEqual(["model", "mail", "issues", "infra"]);
    expect(names("dev")).toHaveLength(5);
    expect(names("custom")).toHaveLength(5);
  });
  it("always retains configured integrations outside the profile", () => {
    expect(names("home", { infra: { configured: true } as IntegrationStatus })).toContain("infra");
  });
});
